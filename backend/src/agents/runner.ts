// Turns the agents' per-second scores into the decisions they actually announce.
// Pure and deterministic: the same storm always gives the same decisions at the same seconds.
//
// Rules, per agent and corridor (everyone starts on an implicit "hold", nothing emitted at 0 s):
//  1. Score on the agent's cadence (Sentinel and Opportunist every 1 s, Strategist every 10 s).
//  2. A new action is only announced once it has held for SETTLE_SCORES scores in a row.
//     This stops agents flip-flopping when the market whipsaws.
//  3. Exception: at a decision point the player is asking *now*, so any agent whose fresh
//     view on that corridor differs from its last announced action announces it immediately.

import type { Action, AgentDecisionEvent, AgentName, Corridor } from "@volatone/shared";
import type { AnalysedStorm } from "../storm/storm";
import { CORRIDORS } from "../storm/storm";
import { actionFor, AGENTS, CADENCE_SECONDS, lastScoringSecond, score } from "./scoring";

/** Scores in a row a new action must hold before it is announced. */
export const SETTLE_SCORES: Record<AgentName, number> = {
  sentinel: 4,    // 4 s
  opportunist: 4, // 4 s
  strategist: 1,  // already slow: scores once every 10 s
};

export interface PlannedDecision {
  second: number;
  agent: AgentName;
  corridor: Corridor;
  risk: number; // the agent's own score, rounded to 3 decimals
  action: Action;
  why: "settled" | "decision_point";
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function planAgentDecisions(storm: AnalysedStorm): PlannedDecision[] {
  const out: PlannedDecision[] = [];
  const dpAt = new Map<number, Corridor[]>();
  for (const dp of storm.data.decisionPoints) {
    dpAt.set(dp.second, [...(dpAt.get(dp.second) ?? []), dp.corridor]);
  }

  for (const agent of AGENTS) {
    for (const corridor of CORRIDORS) {
      let announced: Action = "hold";
      let candidate: Action | null = null;
      let streak = 0;
      for (let s = 0; s < storm.seconds; s++) {
        const scoredNow = s % CADENCE_SECONDS[agent] === 0;
        const askedNow = dpAt.get(s)?.includes(corridor) ?? false;
        if (!scoredNow && !askedNow) continue;

        const sc = score(agent, storm, corridor, lastScoringSecond(agent, s));
        const act = actionFor(agent, sc);
        const emit = (why: PlannedDecision["why"]) => {
          out.push({ second: s, agent, corridor, risk: round3(sc), action: act, why });
          announced = act;
          candidate = null;
          streak = 0;
        };

        if (act === announced) {
          candidate = null;
          streak = 0;
          continue;
        }
        if (askedNow) {
          emit("decision_point");
          continue;
        }
        streak = act === candidate ? streak + 1 : 1;
        candidate = act;
        if (streak >= SETTLE_SCORES[agent]) emit("settled");
      }
    }
  }

  // Time order; within a second, a fixed agent then corridor order.
  return out.sort(
    (a, b) =>
      a.second - b.second ||
      AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent) ||
      CORRIDORS.indexOf(a.corridor) - CORRIDORS.indexOf(b.corridor),
  );
}

/** Each agent's latest announced action on a corridor at a given second ("hold" if none yet). */
export function viewAt(plan: PlannedDecision[], agent: AgentName, corridor: Corridor, second: number): Action {
  let view: Action = "hold";
  for (const d of plan) {
    if (d.second > second) break;
    if (d.agent === agent && d.corridor === corridor) view = d.action;
  }
  return view;
}

const NAME: Record<AgentName, string> = {
  sentinel: "Sentinel",
  opportunist: "Opportunist",
  strategist: "Strategist",
};

/**
 * Plain-English fallback, used when no cached Gemini text exists for this decision.
 * Never claims more than the rule does.
 */
export function fallbackExplanation(d: PlannedDecision): string {
  const who = NAME[d.agent];
  const pct = Math.round(d.risk * 100);
  switch (d.agent) {
    case "sentinel":
      return d.action === "hold"
        ? `${who}: ${d.corridor} has settled (risk ${pct}%). No protection needed for now.`
        : d.action === "hedge"
          ? `${who}: ${d.corridor} is moving sharply (risk ${pct}%). Buying protection, just in case.`
          : `${who}: ${d.corridor} is moving violently (risk ${pct}%). Cutting exposure now.`;
    case "opportunist":
      return d.action === "hold"
        ? `${who}: ${d.corridor} is jumpy but already bouncing back (risk ${pct}%). Staying put.`
        : d.action === "hedge"
          ? `${who}: ${d.corridor} keeps moving one way (risk ${pct}%). Worth some protection.`
          : `${who}: ${d.corridor} is wild with no bounce yet (risk ${pct}%). Even I'd cut back.`;
    case "strategist":
      return d.action === "hold"
        ? `${who}: the bigger picture for ${d.corridor} looks calm enough (risk ${pct}%).`
        : d.action === "hedge"
          ? `${who}: trouble is spreading across the map, and ${d.corridor} could be next (risk ${pct}%).`
          : `${who}: most of the map is in a storm, including ${d.corridor} (risk ${pct}%). Reduce.`;
  }
}

/** Build the shared-format event. `t` is replay ms; `explanation` defaults to the fallback. */
export function toEvent(d: PlannedDecision, id: string, explanation?: string): AgentDecisionEvent {
  return {
    id,
    t: d.second * 1000,
    type: "agent_decision",
    agent: d.agent,
    corridor: d.corridor,
    risk: d.risk,
    action: d.action,
    explanation: explanation ?? fallbackExplanation(d),
  };
}
