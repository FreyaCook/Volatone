// Pure parts of the Tiger Data layer. No live database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VolatoneEvent } from "@volatone/shared";
import { parseClientMessage } from "../src/engine/server";
import { tigerEnabled } from "../src/tiger/config";
import { createTiger } from "../src/tiger";
import { BoundedQueue, CircuitBreaker, logOnce, safeError } from "../src/tiger/queue";
import { offReport, shapeReport, unavailableReport, type RawReport } from "../src/tiger/report";
import { RowMapper } from "../src/tiger/rows";
import { TigerWriter } from "../src/tiger/writer";

describe("BoundedQueue", () => {
  it("drops the oldest rows when full and counts the drops", () => {
    const q = new BoundedQueue<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => q.push(n));
    assert.equal(q.size, 3);
    assert.equal(q.dropped, 2);
    assert.deepEqual(q.take(10), [3, 4, 5]);
    assert.equal(q.size, 0);
  });

  it("take returns the oldest first and leaves the rest", () => {
    const q = new BoundedQueue<number>(10);
    [1, 2, 3].forEach((n) => q.push(n));
    assert.deepEqual(q.take(2), [1, 2]);
    assert.equal(q.size, 1);
  });

  it("requeue puts rows back at the front; overflow drops the oldest and counts", () => {
    const q = new BoundedQueue<number>(4);
    [10, 11, 12].forEach((n) => q.push(n));
    q.requeue([1, 2]); // 1 2 10 11 12 -> over by one
    assert.equal(q.dropped, 1);
    assert.deepEqual(q.take(10), [2, 10, 11, 12]);
  });
});

describe("CircuitBreaker", () => {
  it("opens after 3 failures in a row and stays shut for 30 s", () => {
    const b = new CircuitBreaker(3, 30_000);
    b.failure(1000); b.failure(1000);
    assert.equal(b.canTry(1000), true);
    b.failure(1000);
    assert.equal(b.isOpen, true);
    assert.equal(b.canTry(1000 + 29_999), false);
    assert.equal(b.canTry(1000 + 30_000), true);
  });

  it("a success resets the count", () => {
    const b = new CircuitBreaker(3, 30_000);
    b.failure(0); b.failure(0); b.success(); b.failure(0); b.failure(0);
    assert.equal(b.isOpen, false);
    assert.equal(b.canTry(0), true);
  });
});

describe("logging without secrets", () => {
  it("logOnce prints each distinct message once", () => {
    const out: string[] = [];
    const l = logOnce((m) => out.push(m));
    l("a"); l("a"); l("b");
    assert.deepEqual(out, ["a", "b"]);
  });

  it("safeError removes the URL, host, address and password", () => {
    const url = "postgres://tsdbadmin:hunter2pw@abc123.tsdb.cloud.timescale.com:35000/tsdb?sslmode=require";
    const msg = safeError(new Error(`connect ETIMEDOUT 10.1.2.3:35000 to ${url} host abc123.tsdb.cloud.timescale.com pw hunter2pw`), [url, "hunter2pw"]);
    for (const bad of ["hunter2pw", "abc123", "timescale", "10.1.2.3", "tsdbadmin"]) assert.ok(!msg.includes(bad), `leaked ${bad}: ${msg}`);
  });
});

describe("tigerEnabled", () => {
  it("is on only when a URL is set, unless TIGER=off", () => {
    assert.equal(tigerEnabled({}), false);
    assert.equal(tigerEnabled({ TIGER_DATABASE_URL: "  " }), false);
    assert.equal(tigerEnabled({ TIGER_DATABASE_URL: "postgres://x" }), true);
    assert.equal(tigerEnabled({ TIGER_DATABASE_URL: "postgres://x", TIGER: "off" }), false);
    assert.equal(tigerEnabled({ TIGER_DATABASE_URL: "postgres://x", TIGER: "ON" }), true);
    assert.equal(tigerEnabled({ TIGER: "on" }), false); // "on" without a URL stays off
  });
});

describe("RowMapper", () => {
  let n = 0;
  const mk = (speed = 1) => new RowMapper({ scenario: "S", seed: 7, speed: () => speed, now: () => new Date("2026-11-14T12:00:00Z"), newId: () => `run-${++n}` });
  const tick = (t: number): VolatoneEvent => ({ id: "t" + t, t, type: "tick", corridor: "USD-JPY", risk: 0.4, state: "spreading" });

  it("starts a run at the first tick and writes one risk row per tick", () => {
    n = 0;
    const m = mk(3);
    const rows = m.handle(tick(0));
    assert.deepEqual(rows.map((r) => r.table), ["runs", "risk_ticks"]);
    assert.equal(rows[0].table === "runs" && rows[0].speed, 3);
    assert.deepEqual(m.handle(tick(1000)).map((r) => r.table), ["risk_ticks"]);
  });

  it("a reset starts a new run id; ticks at t=0 after it do not start another", () => {
    n = 0;
    const m = mk();
    m.handle(tick(0));
    const rs = m.handle({ id: "r", t: 0, type: "reset", speed: 2 });
    assert.equal(rs.length, 1);
    assert.equal(rs[0].table === "runs" && rs[0].speed, 2);
    assert.equal(m.runId, "run-2");
    assert.deepEqual(m.handle(tick(0)).map((r) => r.table), ["risk_ticks"]);
  });

  it("maps agent views, moves, outcomes and tx batches; a late tx keeps its own run", () => {
    n = 0;
    const m = mk();
    m.handle(tick(0));
    m.handle({ id: "d1", t: 25000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.7, action: "hedge", explanation: "x" });
    m.handle({ id: "m1", t: 26000, type: "player_move", corridor: "USD-JPY", action: "reduce" });
    const [out] = m.handle({ id: "o1", t: 40000, type: "player_outcome", moveId: "m1", result: "good", reason: "why" });
    assert.ok(out.table === "events" && out.kind === "outcome" && out.corridor === "USD-JPY" && out.action === "reduce");
    m.handle({ id: "r2", t: 0, type: "reset" }); // new run, run-2
    const [tx] = m.handle({ id: "x1", t: 100, type: "tx_confirmed", signature: "sig", eventIds: ["d1", "m1"], confirmMs: 900 });
    assert.ok(tx.table === "tx_log" && tx.run_id === "run-1" && tx.events === 2 && tx.confirm_ms === 900 && tx.ok);
    const [bad] = m.handle({ id: "x2", t: 100, type: "tx_failed", eventIds: ["o1"], error: "e" });
    assert.ok(bad.table === "tx_log" && !bad.ok && bad.signature === null && bad.confirm_ms === null);
  });

  it("ignores events before any run and escalations", () => {
    const m = mk();
    assert.deepEqual(m.handle({ id: "e", t: 5000, type: "escalation", corridor: "USD-JPY", from: "calm", to: "storm" }), []);
  });
});

describe("report shaping", () => {
  const raw: RawReport = {
    // pg returns numeric columns as strings sometimes: shaping must cope
    peaks: [{ corridor: "GBP-USD", peak: "0.5123", mean: 0.2 }, { corridor: "USD-JPY", peak: 0.91, mean: "0.4" }] as never,
    agentViews: 43 as never,
    moves: [{ replay_t: 26000, corridor: "USD-JPY", action: "hedge", result: "good", reason: "r", views: [{ agent: "sentinel", action: "hedge", risk: 0.7 }] },
            { replay_t: 73000, corridor: "GBP-USD", action: "hold", result: null, reason: null, views: null }],
    tx: { n: "20" as never, min: 796, mean: "1066.4" as never, max: 1390, failures: 1 },
  };

  it("orders corridors, rounds, and keeps moves with their outcomes and agent views", () => {
    const r = shapeReport(raw, "run-x", 12.6, "continuous");
    assert.equal(r.status, "ok");
    assert.deepEqual(r.corridors?.map((c) => c.corridor), ["USD-JPY", "GBP-USD"]);
    assert.equal(r.corridors?.[1].peakRisk, 0.512);
    assert.equal(r.agentViews, 43);
    assert.equal(r.queryMs, 13);
    assert.equal(r.moves?.[0].views[0].agent, "sentinel");
    assert.equal(r.moves?.[1].result, null);
    assert.deepEqual(r.moves?.[1].views, []);
    assert.deepEqual(r.solana, { count: 20, minMs: 796, meanMs: 1066, maxMs: 1390, failures: 1 });
    assert.equal(r.aggregate, "continuous");
  });

  it("an empty run still shapes (no Solana batches: nulls, not NaN)", () => {
    const r = shapeReport({ peaks: [], agentViews: 0, moves: [], tx: { n: 0, min: null, mean: null, max: null, failures: 0 } }, "r", 1, "view");
    assert.deepEqual(r.solana, { count: 0, minMs: null, meanMs: null, maxMs: null, failures: 0 });
    assert.deepEqual(r.corridors, []);
  });

  it("unavailable and off carry only a status", () => {
    assert.deepEqual(unavailableReport(), { type: "report", status: "unavailable" });
    assert.deepEqual(offReport(), { type: "report", status: "off" });
  });
});

describe("the writer never waits on or breaks because of the database", () => {
  const failing = () => {
    let calls = 0;
    const pool = { query: async () => { calls++; throw new Error("connect ETIMEDOUT 10.0.0.1:5432"); }, end: async () => {}, on: () => {} };
    return { pool: pool as never, calls: () => calls };
  };
  const tick: VolatoneEvent = { id: "t", t: 0, type: "tick", corridor: "USD-JPY", risk: 0.1, state: "calm" };

  it("onEvent is synchronous and queues rows even if the database is down", () => {
    const { pool } = failing();
    const w = new TigerWriter(pool, { scenario: "S", seed: 1, speed: () => 1 }, () => {});
    w.onEvent(tick);
    assert.equal(w.queue.size, 2); // runs + risk_ticks
  });

  it("after 3 failed flushes it stops trying, keeps the rows, and logs the error once", async () => {
    const { pool, calls } = failing();
    const logs: string[] = [];
    const w = new TigerWriter(pool, { scenario: "S", seed: 1, speed: () => 1 }, (m) => logs.push(m));
    w.onEvent(tick);
    for (let i = 0; i < 3; i++) await w.flush();
    assert.equal(w.breaker.isOpen, true);
    const before = calls();
    await w.flush();
    await w.flush();
    assert.equal(calls(), before, "no database call while the breaker is open");
    assert.equal(w.queue.size, 2, "rows are kept");
    assert.equal(logs.length, 1, "the same error is logged once");
    assert.ok(!logs[0].includes("10.0.0.1"));
  });

  it("drops the oldest rows past the cap and counts them", () => {
    const { pool } = failing();
    const w = new TigerWriter(pool, { scenario: "S", seed: 1, speed: () => 1 }, () => {});
    for (let i = 0; i < 6000; i++) w.onEvent({ ...tick, t: i * 1000, id: "t" + i });
    assert.equal(w.queue.size, 5000);
    assert.ok(w.queue.dropped >= 1000);
  });
});

describe("createTiger and the report states", () => {
  it("is null when switched off or without a URL", () => {
    assert.equal(createTiger({}, { scenario: "S", seed: 1, speed: () => 1 }, () => {}), null);
    assert.equal(createTiger({ TIGER_DATABASE_URL: "postgres://u:p@127.0.0.1:1/x", TIGER: "off" }, { scenario: "S", seed: 1, speed: () => 1 }, () => {}), null);
  });

  it("with an unreachable database the report says unavailable and nothing throws", async () => {
    const t = createTiger({ TIGER_DATABASE_URL: "postgres://u:p@127.0.0.1:1/x" }, { scenario: "S", seed: 1, speed: () => 1 }, () => {})!;
    t.onEvent({ id: "t", t: 0, type: "tick", corridor: "USD-JPY", risk: 0.1, state: "calm" });
    assert.deepEqual(await t.report(), { type: "report", status: "unavailable" });
    await t.stop();
  });
});

describe("get_report message", () => {
  it("parses, and other messages are unchanged", () => {
    assert.deepEqual(parseClientMessage('{"type":"get_report"}'), { type: "get_report" });
    assert.deepEqual(parseClientMessage('{"type":"start","speed":3}'), { type: "start", speed: 3 });
    assert.equal(parseClientMessage('{"type":"report"}'), null);
    assert.equal(parseClientMessage("nope"), null);
  });
});
