// The three agents' scoring rules. Plain code, no AI: Gemini only explains the result.
// Each agent turns signals into a 0..1 risk score, then thresholds turn the score into an action.

import type { Action, AgentName, Corridor } from "@volatone/shared";
import type { AnalysedStorm } from "../storm/storm";

interface Thresholds {
  hedge: number;  // score >= hedge  => hedge
  reduce: number; // score >= reduce => reduce (otherwise hold)
}

export const THRESHOLDS: Record<AgentName, Thresholds> = {
  sentinel: { hedge: 0.4, reduce: 0.65 },    // cautious: acts early
  opportunist: { hedge: 0.5, reduce: 0.8 },  // contrarian: needs a lot to worry
  strategist: { hedge: 0.4, reduce: 0.7 },
};

/** How often each agent re-scores, in replay seconds. */
export const CADENCE_SECONDS: Record<AgentName, number> = {
  sentinel: 1,
  opportunist: 1,
  strategist: 10,
};

export const AGENTS: readonly AgentName[] = ["sentinel", "opportunist", "strategist"];

/** Sentinel: "the scariest number" on its own corridor. */
export function sentinelScore(storm: AnalysedStorm, c: Corridor, s: number): number {
  const sig = storm.signals[c][s];
  return Math.max(sig.shock, sig.jumpiness);
}

/** Opportunist: jumpy, but a move that is already bouncing back is a chance, not a danger. */
export function opportunistScore(storm: AnalysedStorm, c: Corridor, s: number): number {
  const sig = storm.signals[c][s];
  return sig.jumpiness * (1 - sig.bounceBack);
}

/** Strategist: half its own slow (30 s) jumpiness, half how much of the map is in trouble. */
export function strategistScore(storm: AnalysedStorm, c: Corridor, s: number): number {
  return 0.5 * storm.signals[c][s].slowJumpiness + 0.5 * storm.contagion(c, s);
}

export function score(agent: AgentName, storm: AnalysedStorm, c: Corridor, s: number): number {
  switch (agent) {
    case "sentinel":
      return sentinelScore(storm, c, s);
    case "opportunist":
      return opportunistScore(storm, c, s);
    case "strategist":
      return strategistScore(storm, c, s);
  }
}

export function actionFor(agent: AgentName, riskScore: number): Action {
  const t = THRESHOLDS[agent];
  if (riskScore >= t.reduce) return "reduce";
  if (riskScore >= t.hedge) return "hedge";
  return "hold";
}

/** The last second at or before `s` on which this agent scores. */
export const lastScoringSecond = (agent: AgentName, s: number): number =>
  s - (s % CADENCE_SECONDS[agent]);
