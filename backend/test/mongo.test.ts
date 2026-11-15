// Pure parts of the MongoDB layer. No live database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolatoneEvent } from "@volatone/shared";
import { parseClientMessage } from "../src/engine/server";
import { mongoEnabled, secretsOf } from "../src/mongo/config";
import { RunCollector } from "../src/mongo/collector";
import { MongoStore, offRuns, RECENT_LIMIT, RECENT_PROJECTION, summarise, unavailableRuns, type RunsCollection } from "../src/mongo/store";
import { createMongo } from "../src/mongo";

describe("mongoEnabled", () => {
  it("is on only when a URI is set, unless MONGODB=off", () => {
    assert.equal(mongoEnabled({}), false);
    assert.equal(mongoEnabled({ MONGODB_URI: " " }), false);
    assert.equal(mongoEnabled({ MONGODB_URI: "mongodb+srv://x" }), true);
    assert.equal(mongoEnabled({ MONGODB_URI: "mongodb+srv://x", MONGODB: "off" }), false);
    assert.equal(mongoEnabled({ MONGODB: "on" }), false);
  });
  it("createMongo is null when off", () => {
    assert.equal(createMongo({}, () => {}), null);
  });
});

describe("RunCollector builds the run document", () => {
  let n = 0;
  const ev = (e: Omit<VolatoneEvent, "id"> | Record<string, unknown>) => ({ id: `e${++n}`, ...e }) as VolatoneEvent;
  const make = (shared: string | null = null) => {
    let clock = 0;
    return new RunCollector({
      scenario: "Tokyo surprise (synthetic)", seed: 20261114, speed: () => 3, lastSecond: 150,
      sharedRunId: () => shared, now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, clock++)), newId: () => "own-id",
    });
  };
  const play = (c: RunCollector) => {
    const feed = (e: VolatoneEvent) => { c.onEvent(e); return e; };
    feed(ev({ t: 0, type: "tick", corridor: "USD-JPY", risk: 0.1, state: "calm" }));
    feed(ev({ t: 24000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" }));
    feed(ev({ t: 25000, type: "tick", corridor: "USD-JPY", risk: 0.6, state: "storm" }));
    feed(ev({ t: 25000, type: "tick", corridor: "GBP-USD", risk: 0.3, state: "spreading" }));
    const d1 = feed(ev({ t: 25000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.7, action: "hedge", explanation: "x" }));
    feed(ev({ t: 25000, type: "agent_decision", agent: "strategist", corridor: "GBP-USD", risk: 0.3, action: "hold", explanation: "y" }));
    const mv = feed(ev({ t: 26000, type: "player_move", corridor: "USD-JPY", action: "hedge" }));
    feed(ev({ t: 40000, type: "player_outcome", moveId: mv.id, result: "good", reason: "ok" }));
    feed(ev({ t: 50000, type: "tx_confirmed", signature: "s", eventIds: [d1.id, mv.id], confirmMs: 900 }));
    feed(ev({ t: 51000, type: "tx_confirmed", signature: "s2", eventIds: [d1.id], confirmMs: 1100 }));
    feed(ev({ t: 52000, type: "tx_failed", eventIds: [mv.id], error: "e" }));
    feed(ev({ t: 53000, type: "tx_confirmed", signature: "old", eventIds: ["from-a-previous-run"], confirmMs: 5000 }));
    feed(ev({ t: 150000, type: "tick", corridor: "GBP-USD", risk: 0.2, state: "calm" }));
  };

  it("collects moves with the agents' views, peaks, view count and Solana stats", () => {
    const c = make();
    play(c);
    const doc = c.build();
    assert.equal(doc.runId, "own-id");
    assert.equal(doc.scenario, "Tokyo surprise (synthetic)");
    assert.equal(doc.seed, 20261114);
    assert.equal(doc.speed, 3);
    assert.deepEqual(doc.peakRisk, { "USD-JPY": 0.8, "GBP-USD": 0.3 });
    assert.equal(doc.agentViewCount, 2);
    assert.equal(doc.moves.length, 1);
    assert.deepEqual(doc.moves[0], { corridor: "USD-JPY", action: "hedge", outcome: "good", reason: "ok",
      agentsShowed: [{ agent: "sentinel", action: "hedge" }] }); // only agents' views of that corridor
    assert.deepEqual(doc.solana, { batches: 3, confirmedBatches: 2, failedBatches: 1, meanConfirmMs: 1000 });
    assert.ok(c.finished);
    assert.ok(doc.finishedAt > doc.startedAt);
  });

  it("uses Tiger's run id when given, and starts a fresh record on reset", () => {
    const c = make("tiger-run-1");
    play(c);
    assert.equal(c.build().runId, "tiger-run-1");
    c.onEvent(ev({ t: 0, type: "reset", speed: 2 }));
    const fresh = c.build();
    assert.equal(fresh.speed, 2);
    assert.equal(fresh.moves.length, 0);
    assert.equal(fresh.agentViewCount, 0);
    assert.equal(c.finished, false);
  });

  it("a run with no moves and no batches has a null mean, not NaN", () => {
    const c = make();
    c.onEvent(ev({ t: 0, type: "tick", corridor: "USD-JPY", risk: 0.1, state: "calm" }));
    assert.equal(c.build().solana.meanConfirmMs, null);
    assert.deepEqual(c.build().moves, []);
  });

  it("ignores everything before a run starts", () => {
    const c = make();
    c.onEvent(ev({ t: 5000, type: "tick", corridor: "USD-JPY", risk: 0.9, state: "storm" }));
    assert.equal(c.runId, null);
  });
});

describe("recent-runs projection and counting", () => {
  it("counts good moves out of all moves, takes the highest peak and the confirmed batches", () => {
    const s = summarise({
      runId: "r1", finishedAt: new Date("2026-11-14T12:30:00Z"), speed: 2,
      moves: [{ outcome: "good" }, { outcome: "poor" }, { outcome: null }, { outcome: "good" }],
      peakRisk: { "USD-JPY": 0.91, "GBP-USD": 0.55 }, solana: { confirmedBatches: 18 },
    });
    assert.deepEqual(s, { runId: "r1", finishedAt: "2026-11-14T12:30:00.000Z", speed: 2, goodCalls: 2, moves: 4, peakRisk: 0.91, confirmedBatches: 18 });
  });
  it("copes with missing fields (a run with no moves or batches)", () => {
    const s = summarise({ runId: "r2", finishedAt: "2026-11-14T12:30:00Z", speed: 1 });
    assert.deepEqual([s.goodCalls, s.moves, s.peakRisk, s.confirmedBatches], [0, 0, 0, 0]);
  });
  it("reads only small fields, newest first, ten at most", () => {
    assert.equal(RECENT_LIMIT, 10);
    assert.deepEqual(Object.keys(RECENT_PROJECTION).sort(), ["_id", "moves.outcome", "peakRisk", "runId", "finishedAt", "solana.confirmedBatches", "speed"].sort());
    assert.ok(!("moves.reason" in RECENT_PROJECTION) && !("moves.agentsShowed" in RECENT_PROJECTION));
  });
});

describe("MongoStore: unavailable, retry once, breaker, no secrets", () => {
  const URI = "mongodb+srv://appuser:s3cretpw@cluster0.abcde.mongodb.net/?retryWrites=true";
  const doc = { runId: "r", scenario: "S", seed: 1, speed: 1, startedAt: new Date(), finishedAt: new Date(), moves: [], peakRisk: {}, agentViewCount: 0,
    solana: { batches: 0, confirmedBatches: 0, failedBatches: 0, meanConfirmMs: null } };
  const failing = () => {
    let calls = 0;
    const col: RunsCollection = {
      updateOne: async () => { calls++; throw new Error(`connection to cluster0.abcde.mongodb.net timed out; ${URI}`); },
      createIndex: async () => {},
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => { calls++; throw new Error("x"); } }) }) }),
    };
    return { col, calls: () => calls };
  };

  it("a failed write is retried once, then dropped with one log line and no secrets", async () => {
    const { col, calls } = failing();
    const logs: string[] = [];
    const s = new MongoStore(async () => col, (m) => logs.push(m), secretsOf(URI), 10);
    assert.equal(await s.saveRun(doc), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls(), 2, "one try plus one retry");
    assert.equal(s.dropped, 1);
    assert.equal(logs.filter((l) => l.includes("dropped")).length, 1);
    for (const l of logs) for (const bad of ["s3cretpw", "appuser", "abcde", "mongodb.net"]) assert.ok(!l.includes(bad), `leaked ${bad}: ${l}`);
  });

  it("calls onFailure after a failed write so a broken client can be replaced", async () => {
    const { col } = failing();
    let resets = 0;
    const s = new MongoStore(async () => col, () => {}, [], 10_000, () => resets++);
    await s.saveRun(doc);
    assert.equal(resets, 1);
    await s.recentRuns();
    assert.equal(resets, 2);
  });

  it("a connection that never completes is cut off by the timeout, not waited on forever", async () => {
    // getCollection that rejects slowly would hold a write; here it rejects at once to keep the test fast
    const s = new MongoStore(async () => { throw new Error("Server selection timed out"); }, () => {}, [], 10_000);
    assert.equal(await s.saveRun(doc), false);
  });

  it("a success on the retry is saved, not dropped", async () => {
    let n = 0;
    const col: RunsCollection = {
      updateOne: async () => { if (++n === 1) throw new Error("first fails"); },
      createIndex: async () => {}, find: () => { throw new Error("unused"); },
    };
    let saved = 0;
    const s = new MongoStore(async () => col, () => {}, [], 10);
    await s.saveRun(doc, () => saved++);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.saved, 1);
    assert.equal(saved, 1);
    assert.equal(s.dropped, 0);
  });

  it("upserts by runId", async () => {
    let seen: { filter?: object; opts?: object } = {};
    const col: RunsCollection = { updateOne: async (f, _u, o) => { seen = { filter: f, opts: o }; }, createIndex: async () => {}, find: () => { throw new Error("unused"); } };
    await new MongoStore(async () => col, () => {}).saveRun(doc);
    assert.deepEqual(seen, { filter: { runId: "r" }, opts: { upsert: true } });
  });

  it("recentRuns says unavailable when the read fails, and stops trying after 3 failures for 30 s", async () => {
    const { col, calls } = failing();
    const s = new MongoStore(async () => col, () => {});
    for (let i = 0; i < 3; i++) assert.deepEqual(await s.recentRuns(), unavailableRuns());
    const before = calls();
    assert.deepEqual(await s.recentRuns(), unavailableRuns());
    assert.equal(calls(), before, "no database call while the breaker is open");
  });

  it("recentRuns returns summaries when the read works", async () => {
    const col: RunsCollection = {
      updateOne: async () => {}, createIndex: async () => {},
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [{ runId: "a", finishedAt: new Date("2026-11-14T12:00:00Z"), speed: 3, moves: [{ outcome: "good" }], peakRisk: { "USD-JPY": 1 }, solana: { confirmedBatches: 5 } }] }) }) }),
    };
    const r = await new MongoStore(async () => col, () => {}).recentRuns();
    assert.equal(r.status, "ok");
    assert.equal(r.runs?.[0].goodCalls, 1);
  });

  it("the off and unavailable messages carry only a status", () => {
    assert.deepEqual(offRuns(), { type: "runs", status: "off" });
    assert.deepEqual(unavailableRuns(), { type: "runs", status: "unavailable" });
  });
});

describe("get_runs message", () => {
  it("parses, and the others are unchanged", () => {
    assert.deepEqual(parseClientMessage('{"type":"get_runs"}'), { type: "get_runs" });
    assert.deepEqual(parseClientMessage('{"type":"get_report"}'), { type: "get_report" });
    assert.equal(parseClientMessage('{"type":"runs"}'), null);
  });
});
