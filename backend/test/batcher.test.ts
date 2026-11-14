// The batching rule, plus a simulated full replay to count devnet transactions.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDecisionEvent, PlayerMoveEvent, PlayerOutcomeEvent } from "@volatone/shared";
import { Batcher, FLUSH_AFTER_MS, MAX_PER_TX, sendBatch, type Batch, type LoggableEvent } from "../src/chain/batcher";
import { createIdSource } from "../src/ids";
import { loadStorm } from "../src/storm/committed";
import { judge, LOOKAHEAD_SECONDS } from "../src/storm/outcome";
import { planAgentDecisions, toEvent } from "../src/agents/runner";

const decision = (id: string, t: number): AgentDecisionEvent => ({
  id, t, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.5, action: "hedge", explanation: "x",
});
const move = (id: string, t: number): PlayerMoveEvent => ({ id, t, type: "player_move", corridor: "USD-JPY", action: "hedge" });
const outcome = (id: string, t: number, moveId: string): PlayerOutcomeEvent => ({
  id, t, type: "player_outcome", moveId, result: "good", reason: "x",
});
const ids = (batches: Batch[]) => batches.map((b) => b.map((e) => e.id));

test("agent decisions wait until the oldest has waited 3 s, then go together", () => {
  const b = new Batcher();
  assert.deepEqual(b.push(decision("a", 0), 0), []);
  assert.deepEqual(b.push(decision("b", 0), 1000), []);
  assert.deepEqual(b.due(FLUSH_AFTER_MS - 1), []);
  assert.deepEqual(ids(b.due(FLUSH_AFTER_MS)), [["a", "b"]]);
  assert.equal(b.waiting, 0);
  assert.deepEqual(b.due(10_000), [], "nothing waiting, nothing sent");
});

test("a player move is sent straight away, taking waiting decisions with it", () => {
  const b = new Batcher();
  b.push(decision("a", 0), 0);
  assert.deepEqual(ids(b.push(move("m", 500), 500)), [["a", "m"]]);
  assert.equal(b.waiting, 0);
});

test("a player outcome rides in the next batch rather than forcing one", () => {
  const b = new Batcher();
  assert.deepEqual(b.push(outcome("o", 0, "m"), 0), []);
  b.push(decision("a", 0), 2000);
  assert.deepEqual(ids(b.due(FLUSH_AFTER_MS)), [["o", "a"]]);
});

test(`batches larger than ${MAX_PER_TX} are split in order`, () => {
  const b = new Batcher();
  for (let i = 0; i < 19; i++) b.push(decision(`d${i}`, 0), 0);
  const out = b.due(FLUSH_AFTER_MS);
  assert.deepEqual(out.map((x) => x.length), [8, 8, 3]);
  assert.deepEqual(out.flat().map((e) => e.id), Array.from({ length: 19 }, (_, i) => `d${i}`));
});

test("flushAll (Reset storm) still sends what was waiting", () => {
  const b = new Batcher();
  b.push(decision("a", 0), 0);
  assert.deepEqual(ids(b.flushAll()), [["a"]]);
});

test("sendBatch reports tx_confirmed with our measured confirmMs, or tx_failed honestly", async () => {
  const idSrc = createIdSource(100);
  let now = 1000;
  const clock = { nowMs: () => now, replayT: () => 42_000 };
  const ok = await sendBatch([decision("a", 0), move("m", 0)], async () => {
    now += 850;
    return { signature: "SIG" };
  }, idSrc, clock);
  assert.deepEqual(ok, {
    id: "evt_0100", t: 42_000, type: "tx_confirmed", signature: "SIG", eventIds: ["a", "m"], confirmMs: 850,
  });
  const bad = await sendBatch([decision("b", 0)], async () => {
    throw new Error("Blockhash not found");
  }, idSrc, clock);
  assert.deepEqual(bad, { id: "evt_0101", t: 42_000, type: "tx_failed", eventIds: ["b"], error: "Blockhash not found" });
});

test("full replay: player answers all 4 prompts; count logged events and transactions", () => {
  const storm = loadStorm();
  const idSrc = createIdSource();
  const timeline: { t: number; event: LoggableEvent }[] = [];
  for (const d of planAgentDecisions(storm)) timeline.push({ t: d.second * 1000, event: toEvent(d, idSrc.next()) });
  for (const dp of storm.data.decisionPoints) {
    const m: PlayerMoveEvent = { id: idSrc.next(), t: dp.second * 1000 + 3000, type: "player_move", corridor: dp.corridor, action: "hedge" };
    const j = judge(storm, dp, m.action);
    timeline.push({ t: m.t, event: m });
    timeline.push({
      t: (dp.second + LOOKAHEAD_SECONDS) * 1000,
      event: { id: idSrc.next(), t: (dp.second + LOOKAHEAD_SECONDS) * 1000, type: "player_outcome", moveId: m.id, ...j },
    });
  }
  timeline.sort((a, b) => a.t - b.t);

  // Drive the batcher like the worker will: events as they happen, due() every 250 ms.
  const b = new Batcher();
  const sent: Batch[] = [];
  let k = 0;
  for (let now = 0; now <= 160_000; now += 250) {
    while (k < timeline.length && timeline[k].t <= now) sent.push(...b.push(timeline[k].event, now)), k++;
    sent.push(...b.due(now));
  }
  sent.push(...b.flushAll());

  const logged = sent.flat();
  assert.equal(logged.length, timeline.length, "every loggable event is logged exactly once");
  assert.equal(new Set(logged.map((e) => e.id)).size, logged.length);
  console.log(`   logged events: ${logged.length} (${timeline.length - 8} agent decisions + 4 moves + 4 outcomes)`);
  console.log(`   devnet transactions: ${sent.length}, largest batch ${Math.max(...sent.map((x) => x.length))}`);
  assert.ok(sent.length >= 15 && sent.length <= 35, `got ${sent.length} transactions`);
});
