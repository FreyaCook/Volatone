// Agent runner: how many decisions a replay produces, and what the player sees at each
// decision point. Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Action, AgentName } from "@volatone/shared";
import { loadStorm } from "../src/storm/committed";
import { CORRIDORS } from "../src/storm/storm";
import { AGENTS, CADENCE_SECONDS } from "../src/agents/scoring";
import { planAgentDecisions, toEvent, viewAt } from "../src/agents/runner";
import { createIdSource } from "../src/ids";

const storm = loadStorm();
const plan = planAgentDecisions(storm);

test("a full replay gives 35 to 45 agent decisions", () => {
  const per = Object.fromEntries(AGENTS.map((a) => [a, plan.filter((d) => d.agent === a).length]));
  console.log(`   agent decisions: ${plan.length} total`, per);
  assert.ok(plan.length >= 35 && plan.length <= 45, `got ${plan.length}`);
  for (const a of AGENTS) assert.ok(per[a] > 0, `${a} never speaks`);
});

const VIEWS: Record<string, Record<AgentName, Action>> = {
  dp1: { sentinel: "hedge", opportunist: "hold", strategist: "hold" },
  dp2: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
  dp3: { sentinel: "reduce", opportunist: "hold", strategist: "reduce" },
  dp4: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
};

test("at each decision point, the announced views match the designed disagreement", () => {
  for (const dp of storm.data.decisionPoints) {
    for (const a of AGENTS) {
      assert.equal(viewAt(plan, a, dp.corridor, dp.second), VIEWS[dp.id][a], `${dp.id} ${a}`);
    }
  }
});

test("no agent repeats itself: every decision changes that agent's action on that corridor", () => {
  for (const a of AGENTS) {
    for (const c of CORRIDORS) {
      let prev: Action = "hold";
      for (const d of plan.filter((x) => x.agent === a && x.corridor === c)) {
        assert.notEqual(d.action, prev, `${a} ${c} at ${d.second} s`);
        prev = d.action;
      }
    }
  }
});

test("nothing at 0 s, and Strategist only speaks on its 10 s cadence", () => {
  assert.ok(plan.every((d) => d.second > 0));
  for (const d of plan.filter((x) => x.agent === "strategist")) {
    assert.equal(d.second % CADENCE_SECONDS.strategist, 0, `strategist at ${d.second} s`);
  }
});

test("the plan is deterministic", () => {
  assert.deepEqual(planAgentDecisions(storm), plan);
});

test("decisions become valid agent_decision events with replay-time t", () => {
  const ids = createIdSource();
  const ev = toEvent(plan[0], ids.next());
  assert.equal(ev.type, "agent_decision");
  assert.equal(ev.id, "evt_0001");
  assert.equal(ev.t, plan[0].second * 1000);
  assert.ok(ev.explanation.length > 0);
  assert.ok(ev.risk >= 0 && ev.risk <= 1);
});
