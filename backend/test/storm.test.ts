// Lock-in test for the committed storm. If a change to the data, the signals or the agent
// rules breaks the designed story, this fails loudly. Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Action, AgentName, Outcome } from "@volatone/shared";
import { loadStorm, STORM } from "../src/storm/committed";
import { analyse, CORRIDORS } from "../src/storm/storm";
import { judge, lookahead } from "../src/storm/outcome";
import { actionFor, AGENTS, lastScoringSecond, score } from "../src/agents/scoring";

const storm = loadStorm();

test("storm data: 4 corridors x 151 one-second samples (a 150 s replay)", () => {
  assert.equal(STORM.stepMs, 1000);
  for (const c of CORRIDORS) {
    assert.equal(STORM.prices[c].length, 151, c);
    assert.ok(STORM.prices[c].every((p) => Number.isFinite(p) && p > 0), `${c} has a bad price`);
  }
});

test("the 14 escalations happen at exactly the designed seconds", () => {
  const got = storm.escalations.map((e) => [e.second, e.corridor, e.from, e.to]);
  assert.deepEqual(got, [
    [20, "USD-JPY", "calm", "spreading"],
    [35, "USD-JPY", "spreading", "storm"],
    [45, "EUR-JPY", "calm", "spreading"],
    [60, "EUR-JPY", "spreading", "storm"],
    [65, "EUR-USD", "calm", "spreading"],
    [80, "GBP-USD", "calm", "spreading"],
    [88, "EUR-USD", "spreading", "storm"],
    [102, "USD-JPY", "storm", "spreading"],
    [112, "EUR-JPY", "storm", "spreading"],
    [118, "GBP-USD", "spreading", "calm"],
    [124, "EUR-USD", "storm", "spreading"],
    [130, "USD-JPY", "spreading", "calm"],
    [138, "EUR-JPY", "spreading", "calm"],
    [146, "EUR-USD", "spreading", "calm"],
  ]);
});

test("GBP-USD never reaches storm, and everything is calm at the end", () => {
  assert.ok(storm.signals["GBP-USD"].every((s) => s.state !== "storm"));
  for (const c of CORRIDORS) assert.equal(storm.signals[c][150].state, "calm", c);
});

test("decision points are where the design puts them", () => {
  assert.deepEqual(
    STORM.decisionPoints.map((d) => [d.id, d.second, d.corridor]),
    [
      ["dp1", 25, "USD-JPY"],
      ["dp2", 72, "GBP-USD"],
      ["dp3", 95, "EUR-USD"],
      ["dp4", 132, "EUR-JPY"],
    ],
  );
});

const AGENT_ACTIONS: Record<string, Record<AgentName, Action>> = {
  dp1: { sentinel: "hedge", opportunist: "hold", strategist: "hold" },
  dp2: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
  dp3: { sentinel: "reduce", opportunist: "hold", strategist: "reduce" },
  dp4: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
};

for (const dp of STORM.decisionPoints) {
  test(`${dp.id} (${dp.corridor} at ${dp.second} s): each agent's action`, () => {
    for (const agent of AGENTS) {
      const s = lastScoringSecond(agent, dp.second); // Strategist uses its last 10 s score
      const sc = score(agent, storm, dp.corridor, s);
      assert.equal(actionFor(agent, sc), AGENT_ACTIONS[dp.id][agent], `${agent} scored ${sc.toFixed(3)}`);
    }
  });
}

test("every decision point has a split: the agents never all agree", () => {
  for (const [id, actions] of Object.entries(AGENT_ACTIONS)) {
    assert.ok(new Set(Object.values(actions)).size > 1, id);
  }
});

const OUTCOMES: Record<string, Record<Action, Outcome>> = {
  dp1: { hedge: "good", reduce: "good", hold: "poor" },
  dp2: { hedge: "good", reduce: "poor", hold: "poor" },
  dp3: { hedge: "poor", reduce: "poor", hold: "good" },
  dp4: { hedge: "poor", reduce: "poor", hold: "good" },
};

for (const dp of STORM.decisionPoints) {
  test(`${dp.id}: player outcomes are clear-cut and as designed`, () => {
    const la = lookahead(storm, dp);
    // Clear-cut: either risk clearly climbs, or it only falls. Never in between.
    assert.ok(la.worse || la.futureMax < la.now, `${dp.id} is ambiguous: now ${la.now}, max ${la.futureMax}`);
    for (const action of ["hedge", "hold", "reduce"] as const) {
      assert.equal(judge(storm, dp, action).result, OUTCOMES[dp.id][action], `${dp.id} ${action}`);
    }
  });
}

test("analysis is deterministic: analysing the same data twice gives identical results", () => {
  const a = analyse(STORM);
  const b = analyse(structuredClone(STORM));
  assert.deepEqual(a.escalations, b.escalations);
  assert.deepEqual(a.signals, b.signals);
});
