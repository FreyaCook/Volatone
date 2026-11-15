// The replay engine with a fake clock and a fake Sender: a full 150 s run in milliseconds.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import type { PlayerMoveEvent, VolatoneEvent } from "@volatone/shared";
import { DECISION_POINTS, PROMPT_SECONDS, REPLAY_LAST_SECOND } from "@volatone/shared/protocol";
import { planAgentDecisions } from "../src/agents/runner";
import type { Batch } from "../src/chain/batcher";
import type { Sender } from "../src/chain/sender";
import { FakeClock } from "../src/engine/clock";
import { ReplayEngine } from "../src/engine/replay";
import { attachServer, parseClientMessage } from "../src/engine/server";
import { loadStorm } from "../src/storm/committed";
import { judge, LOOKAHEAD_SECONDS } from "../src/storm/outcome";

const storm = loadStorm();
const plan = planAgentDecisions(storm);
const LOGGABLE = new Set(["agent_decision", "player_move", "player_outcome"]);

/** Confirms every batch after 800 fake ms... instantly, recording what it was given. */
function fakeSender(clock: FakeClock): Sender & { batches: Batch[] } {
  const batches: Batch[] = [];
  let n = 0;
  return {
    batches,
    async send(batch, ids, replayT) {
      batches.push(batch);
      return {
        path: "program",
        event: { id: ids.next(), t: replayT(), type: "tx_confirmed", signature: `SIG${++n}`, eventIds: batch.map((e) => e.id), confirmMs: 800 },
      };
    },
  };
}

function setup(withSender = true) {
  const clock = new FakeClock();
  const sender = withSender ? fakeSender(clock) : null;
  const engine = new ReplayEngine({ clock, tickMs: 1000, sender });
  const events: VolatoneEvent[] = [];
  engine.subscribe((e) => events.push(e));
  /** Advance to just after replay second s has played. */
  const toSecond = (s: number) => clock.advance(s * 1000 + 100 - clock.now());
  return { clock, sender, engine, events, toSecond };
}

const ofType = <T extends VolatoneEvent["type"]>(events: VolatoneEvent[], type: T) =>
  events.filter((e): e is Extract<VolatoneEvent, { type: T }> => e.type === type);

test("shared/protocol.ts decision points match storm.json", () => {
  assert.deepEqual(DECISION_POINTS, storm.data.decisionPoints);
  assert.equal(REPLAY_LAST_SECOND, storm.seconds - 1);
});

test("full replay: event order, 4 decision points answered, outcomes, every loggable event in a tx", async () => {
  const { engine, events, sender, clock, toSecond } = setup();
  assert.equal(engine.state, "idle");
  engine.start();
  assert.equal(engine.state, "running");

  const moves: PlayerMoveEvent[] = [];
  const actions = ["hedge", "hold", "reduce", "hold"] as const;
  for (const [i, dp] of storm.data.decisionPoints.entries()) {
    await toSecond(dp.second + 2); // answer 2 s into the prompt
    const r = engine.playerMove(dp.corridor, actions[i]);
    assert.ok(r.ok, `move at ${dp.id}`);
    moves.push(r.event);
  }
  await toSecond(REPLAY_LAST_SECOND);
  assert.equal(engine.state, "finished");
  await clock.advance(5000); // let the last batch wait out its 3 s
  await engine.settled();

  // Counts.
  assert.equal(ofType(events, "tick").length, storm.seconds * 4);
  assert.equal(ofType(events, "escalation").length, storm.escalations.length);
  assert.equal(ofType(events, "agent_decision").length, plan.length);
  assert.equal(ofType(events, "player_move").length, 4);
  const outcomes = ofType(events, "player_outcome");
  assert.equal(outcomes.length, 4);
  assert.equal(ofType(events, "reset").length, 0);

  // Ids are unique and strictly increasing in emission order (except tx results, which take an id when they arrive).
  const nums = events.map((e) => Number(e.id.slice(4)));
  assert.equal(new Set(nums).size, nums.length);
  assert.deepEqual([...nums].sort((a, b) => a - b), nums);

  // Replay time never goes backwards.
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t, `t went back at ${events[i].id}`);

  // Each second starts with its 4 ticks, then escalations, then agent decisions.
  const run = events.filter((e) => e.type !== "tx_confirmed" && e.type !== "player_move");
  const rank = { tick: 0, escalation: 1, agent_decision: 2, player_outcome: 3 } as Record<string, number>;
  for (let i = 1; i < run.length; i++) {
    if (run[i].t === run[i - 1].t) assert.ok(rank[run[i].type] >= rank[run[i - 1].type], `order at ${run[i].id}`);
  }

  // Agent decisions match the plan, in order, at the right time.
  assert.deepEqual(
    ofType(events, "agent_decision").map((e) => [e.t, e.agent, e.corridor, e.action]),
    plan.map((d) => [d.second * 1000, d.agent, d.corridor, d.action]),
  );

  // Moves at 2 s into each prompt; outcomes judged by judge(), emitted when the look-ahead ends.
  for (const [i, dp] of storm.data.decisionPoints.entries()) {
    assert.equal(moves[i].t, (dp.second + 2) * 1000 + 100);
    const o = outcomes[i];
    assert.equal(o.moveId, moves[i].id);
    assert.equal(o.t, (dp.second + LOOKAHEAD_SECONDS) * 1000);
    assert.deepEqual({ result: o.result, reason: o.reason }, judge(storm, dp, actions[i]));
  }

  // Batching: every loggable event logged exactly once; each move went out in a batch that ends with it.
  const logged = sender!.batches.flat().map((e) => e.id);
  const loggable = events.filter((e) => LOGGABLE.has(e.type)).map((e) => e.id);
  assert.deepEqual([...logged].sort(), [...loggable].sort());
  assert.equal(new Set(logged).size, logged.length);
  for (const m of moves) assert.ok(sender!.batches.some((b) => b.at(-1)!.id === m.id), `move ${m.id} sent at once`);
  assert.ok(sender!.batches.every((b) => b.length <= 8));
  const confirmed = ofType(events, "tx_confirmed");
  assert.equal(confirmed.length, sender!.batches.length);
  console.log(`   events: ${events.length}, devnet txs: ${confirmed.length}`);
  engine.stop();
});

test("prompts: a missed prompt logs nothing; wrong corridor, late, second and idle moves are refused", async () => {
  const { engine, events, toSecond } = setup();
  assert.equal(engine.playerMove("USD-JPY", "hedge").ok, false, "idle");
  engine.start();
  const [dp1, dp2] = storm.data.decisionPoints;

  await toSecond(dp1.second - 1);
  assert.equal(engine.playerMove(dp1.corridor, "hedge").ok, false, "before the prompt opens");
  await toSecond(dp1.second);
  assert.equal(engine.prompt()?.id, dp1.id);
  assert.equal(engine.playerMove("GBP-USD", "hedge").ok, false, "wrong corridor");
  assert.equal(engine.playerMove(dp1.corridor, "hedge").ok, true);
  assert.equal(engine.playerMove(dp1.corridor, "reduce").ok, false, "already answered");

  // dp2: let it pass with no answer.
  await toSecond(dp2.second + PROMPT_SECONDS);
  assert.equal(engine.prompt(), null);
  assert.equal(engine.playerMove(dp2.corridor, "hold").ok, false, "prompt closed");
  await toSecond(REPLAY_LAST_SECOND);
  assert.equal(ofType(events, "player_move").length, 1);
  assert.equal(ofType(events, "player_outcome").length, 1);
  assert.ok(!ofType(events, "player_move").some((e) => e.corridor === dp2.corridor));
  engine.stop();
});

test("reset: emits reset, flushes what was waiting, restarts at t = 0, ids continue", async () => {
  const { engine, events, sender, clock, toSecond } = setup();
  engine.start();
  const resetSecond = plan.find((d) => d.second >= 20)!.second; // right after some decisions were announced
  await toSecond(resetSecond);
  const before = events.length;
  const lastId = Number(events.at(-1)!.id.slice(4));
  const waitingIds = events.filter((e) => LOGGABLE.has(e.type)).map((e) => e.id)
    .filter((id) => !sender!.batches.flat().some((x) => x.id === id));
  assert.ok(waitingIds.length > 0, "some decisions are still waiting to be batched");

  engine.reset();
  await engine.settled();
  const after = events.slice(before);
  const reset = after.find((e) => e.type === "reset")!;
  assert.equal(reset.t, 0);
  assert.ok(Number(reset.id.slice(4)) > lastId, "ids never restart");
  // Everything that was waiting got sent (its tx_confirmed may arrive after the reset).
  const sent = new Set(sender!.batches.flat().map((e) => e.id));
  for (const id of waitingIds) assert.ok(sent.has(id), `${id} flushed on reset`);
  // The new run starts again at t = 0, after the reset.
  const firstTick = after.find((e) => e.type === "tick")!;
  assert.equal(firstTick.t, 0);
  assert.ok(Number(firstTick.id.slice(4)) > Number(reset.id.slice(4)));
  assert.equal(engine.history()[0].type, "reset");
  assert.equal(engine.state, "running");

  // A second full run after reset produces the same agent decisions again.
  await clock.advance(REPLAY_LAST_SECOND * 1000 + 100);
  const run2 = engine.history();
  assert.equal(run2.filter((e) => e.type === "agent_decision").length, plan.length);
  assert.equal(engine.state, "finished");

  // start() on a finished run behaves like reset.
  engine.start();
  assert.equal(engine.history()[0].type, "reset");
  engine.stop();
});

test("CHAIN=off (no sender): events flow, no tx events", async () => {
  const { engine, events, toSecond } = setup(false);
  engine.start();
  await toSecond(storm.data.decisionPoints[0].second);
  engine.playerMove(storm.data.decisionPoints[0].corridor, "hedge");
  await toSecond(REPLAY_LAST_SECOND);
  assert.equal(ofType(events, "agent_decision").length, plan.length);
  assert.equal(ofType(events, "player_outcome").length, 1);
  assert.ok(!events.some((e) => e.type === "tx_confirmed" || e.type === "tx_failed"));
  engine.stop();
});

test("late joiner: history is every event since the current run began", async () => {
  const { engine, events, toSecond } = setup();
  engine.start();
  await toSecond(40);
  assert.deepEqual(engine.history(), events, "first run: everything from t = 0");
  engine.reset();
  await toSecond(50);
  const resetAt = events.findIndex((e) => e.type === "reset");
  // Tx results for the previous run that arrive after the reset belong to the new run's feed.
  assert.deepEqual(engine.history(), events.slice(resetAt));
  engine.stop();
});

test("WebSocket: a client that connects mid-run gets the catch-up, then live events; client messages work", async () => {
  const { engine, clock } = setup();
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  attachServer(wss, engine);
  const url = `ws://localhost:${(wss.address() as { port: number }).port}`;

  const connect = async () => {
    const ws = new WebSocket(url);
    const got: VolatoneEvent[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    return { ws, got };
  };
  const flush = () => new Promise((r) => setTimeout(r, 50));

  const a = await connect();
  a.ws.send(JSON.stringify({ type: "start" }));
  await flush();
  assert.equal(engine.state, "running");
  const dp1 = storm.data.decisionPoints[0];
  await clock.advance(dp1.second * 1000 + 100);

  const b = await connect(); // late joiner
  await flush();
  assert.equal(b.got.length, engine.history().length);
  assert.deepEqual(b.got, engine.history());

  b.ws.send(JSON.stringify({ type: "player_move", corridor: dp1.corridor, action: "hedge" }));
  b.ws.send("not json");
  b.ws.send(JSON.stringify({ type: "player_move", corridor: "XXX", action: "hedge" }));
  await flush();
  for (const c of [a, b]) assert.equal(c.got.filter((e) => e.type === "player_move").length, 1);

  a.ws.send(JSON.stringify({ type: "reset" }));
  await flush();
  assert.ok(b.got.some((e) => e.type === "reset"));
  assert.deepEqual(a.got.slice(-engine.history().length), [...engine.history()]);

  a.ws.close();
  b.ws.close();
  engine.stop();
  await new Promise((r) => wss.close(r));
});

/** A WebSocket server on a random port, and a helper that connects and records what it receives. */
async function serve(engine: ReturnType<typeof setup>["engine"]) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  attachServer(wss, engine);
  const url = `ws://localhost:${(wss.address() as { port: number }).port}`;
  const connect = async () => {
    const ws = new WebSocket(url);
    const got: VolatoneEvent[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    await new Promise((r) => setTimeout(r, 80)); // let any catch-up arrive
    return { ws, got };
  };
  const close = async () => { engine.stop(); await new Promise((r) => wss.close(r)); };
  return { connect, close };
}

test("WebSocket: a new connection while the replay is finished gets no history", async () => {
  const { engine, toSecond } = setup();
  engine.start();
  await toSecond(150);
  assert.equal(engine.state, "finished");
  assert.ok(engine.history().length > 0, "there is a finished run in memory");
  const { connect, close } = await serve(engine);
  const c = await connect();
  assert.deepEqual(c.got, [], "nothing is sent: the client shows the start screen");
  c.ws.close();
  await close();
});

test("WebSocket: a new connection while the engine is idle gets no history", async () => {
  const { engine } = setup();
  assert.equal(engine.state, "idle");
  const { connect, close } = await serve(engine);
  const c = await connect();
  assert.deepEqual(c.got, []);
  c.ws.close();
  await close();
});

test("WebSocket: a new connection while the replay is running still gets the whole catch-up", async () => {
  const { engine, toSecond } = setup();
  engine.start();
  await toSecond(30);
  assert.equal(engine.state, "running");
  const { connect, close } = await serve(engine);
  const c = await connect();
  assert.ok(c.got.length > 0);
  assert.deepEqual(c.got, [...engine.history()]);
  c.ws.close();
  await close();
});

test("WebSocket: a finished run can be started again by a client that received no history", async () => {
  const { engine, toSecond } = setup();
  engine.start();
  await toSecond(150);
  const { connect, close } = await serve(engine);
  const c = await connect();
  c.ws.send(JSON.stringify({ type: "start" }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(engine.state, "running");
  assert.equal(c.got[0]?.type, "reset", "the client sees the new run from its reset event");
  c.ws.close();
  await close();
});

test("parseClientMessage accepts only the three message shapes", () => {
  assert.deepEqual(parseClientMessage('{"type":"start"}'), { type: "start" });
  assert.deepEqual(parseClientMessage('{"type":"reset","extra":1}'), { type: "reset" });
  assert.deepEqual(parseClientMessage('{"type":"player_move","corridor":"EUR-USD","action":"reduce"}'),
    { type: "player_move", corridor: "EUR-USD", action: "reduce" });
  for (const bad of ["", "null", "[]", '{"type":"tick"}', '{"type":"player_move","corridor":"EUR-USD","action":"buy"}']) {
    assert.equal(parseClientMessage(bad), null, bad);
  }
});

test("the engine uses a cached explanation when present, the fallback otherwise", async () => {
  const { explanationKey } = await import("../src/agents/explanations");
  const { fallbackExplanation } = await import("../src/agents/runner");
  const clock = new FakeClock();
  const [a, b] = plan;
  const engine = new ReplayEngine({ clock, explanations: new Map([[explanationKey(a), "CACHED"]]) });
  engine.start();
  await clock.advance(b.second * 1000 + 100);
  const decisions = engine.history().filter((e) => e.type === "agent_decision");
  assert.equal(decisions[0].explanation, "CACHED");
  assert.equal(decisions[1].explanation, fallbackExplanation(b));
  engine.stop();
});

// ---------- Speed ----------

/** A full run at `speed`, answering every prompt 2 replay seconds in. Returns all events. */
async function fullRunAt(speed: 1 | 2 | 3) {
  const clock = new FakeClock();
  const sender = fakeSender(clock);
  const engine = new ReplayEngine({ clock, tickMs: 1000, sender });
  const events: VolatoneEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const period = 1000 / speed;
  const toSecond = (s: number) => clock.advance(s * period + period / 10 - clock.now());
  engine.start(speed);
  assert.equal(engine.speed, speed);
  for (const dp of storm.data.decisionPoints) {
    await toSecond(dp.second + 2);
    assert.ok(engine.playerMove(dp.corridor, "hedge").ok, `${dp.id} at speed ${speed}`);
  }
  await toSecond(REPLAY_LAST_SECOND);
  const finishedAt = clock.now();
  assert.equal(engine.state, "finished");
  await clock.advance(5000);
  await engine.settled();
  engine.stop();
  return { events, sender, finishedAt };
}

test("speed 3: same events, same order, same replay times and the same 4 decision points as speed 1", async () => {
  const one = await fullRunAt(1);
  const three = await fullRunAt(3);
  // Everything except tx results (batching runs on wall-clock time, so batches differ). Tx results
  // also take ids, so ids differ: compare each outcome's move by its position instead of its id.
  const strip = (evs: VolatoneEvent[]) => {
    const moveIds = ofType(evs, "player_move").map((m) => m.id);
    return evs
      .filter((e) => e.type !== "tx_confirmed" && e.type !== "tx_failed")
      .map(({ id: _id, ...rest }) =>
        rest.type === "player_outcome" ? { ...rest, moveId: `move #${moveIds.indexOf(rest.moveId)}` } : rest);
  };
  assert.deepEqual(strip(three.events), strip(one.events));
  for (const run of [one, three]) {
    const moves = ofType(run.events, "player_move");
    assert.deepEqual(moves.map((m) => [m.corridor, m.t]), storm.data.decisionPoints.map((dp) => [dp.corridor, (dp.second + 2) * 1000 + 100]));
    assert.equal(ofType(run.events, "player_outcome").length, 4);
    // Every loggable event is still logged exactly once.
    const logged = run.sender.batches.flat().map((e) => e.id);
    assert.deepEqual([...logged].sort(), run.events.filter((e) => LOGGABLE.has(e.type)).map((e) => e.id).sort());
  }
  // A third of the wall-clock time.
  assert.ok(Math.abs(three.finishedAt - one.finishedAt / 3) < 100, `${three.finishedAt} vs ${one.finishedAt}`);
});

test("speed: reset keeps the current speed unless given; the reset event carries it; invalid speeds are ignored", async () => {
  const clock = new FakeClock();
  const engine = new ReplayEngine({ clock, tickMs: 1000 });
  engine.start(7 as never);
  assert.equal(engine.state, "idle", "invalid speed: start ignored");
  engine.start(2);
  assert.equal(engine.speed, 2);
  await clock.advance(5000); // 10 replay seconds at speed 2
  assert.equal(engine.history().at(-1)!.t, 10_000);

  engine.reset();
  assert.deepEqual(engine.history()[0], { ...engine.history()[0], type: "reset", t: 0, speed: 2 });
  engine.reset(3);
  assert.equal(engine.speed, 3);
  assert.equal((engine.history()[0] as { speed?: number }).speed, 3);
  const before = engine.history()[0].id;
  engine.reset(0 as never);
  assert.equal(engine.history()[0].id, before, "invalid speed: reset ignored");
  assert.equal(engine.speed, 3);
  engine.stop();

  for (const bad of ['{"type":"start","speed":4}', '{"type":"start","speed":"2"}', '{"type":"reset","speed":1.5}', '{"type":"reset","speed":null}']) {
    assert.equal(parseClientMessage(bad), null, bad);
  }
  assert.deepEqual(parseClientMessage('{"type":"start","speed":3}'), { type: "start", speed: 3 });
  assert.deepEqual(parseClientMessage('{"type":"reset","speed":2}'), { type: "reset", speed: 2 });
});

test("speed over WebSocket: an invalid speed message changes nothing", async () => {
  const clock = new FakeClock();
  const engine = new ReplayEngine({ clock });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  attachServer(wss, engine);
  const ws = new WebSocket(`ws://localhost:${(wss.address() as { port: number }).port}`);
  await new Promise<void>((r) => ws.on("open", () => r()));
  const flush = () => new Promise((r) => setTimeout(r, 50));
  ws.send(JSON.stringify({ type: "start", speed: 5 }));
  await flush();
  assert.equal(engine.state, "idle");
  ws.send(JSON.stringify({ type: "start", speed: 3 }));
  await flush();
  assert.equal(engine.speed, 3);
  ws.send(JSON.stringify({ type: "reset", speed: 9 }));
  await flush();
  assert.ok(!engine.history().some((e) => e.type === "reset"));
  ws.close();
  engine.stop();
  await new Promise((r) => wss.close(r));
});
