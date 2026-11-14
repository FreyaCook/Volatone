// Judges a player's move at a decision point against what the storm does next.
// Uses only the storm data and the decision point's fixed second, so the same choice
// always gets the same result, whenever in the 8 s window the player clicked.

import type { Action, Outcome } from "@volatone/shared";
import type { AnalysedStorm, DecisionPoint } from "./storm";
import { UP_TO_STORM } from "./storm";

/** Prompt stays open this long (replay seconds). No click = "missed", nothing logged. */
export const PROMPT_SECONDS = 8;
/** The move is judged on what happens this many seconds after the prompt opens. */
export const LOOKAHEAD_SECONDS = 15;
/** Risk must climb at least this much in the look-ahead to count as "getting worse". */
export const WORSE_BY = 0.1;

export interface Lookahead {
  now: number;        // map risk when the prompt opened
  futureMax: number;  // highest map risk in the next 15 s
  worse: boolean;     // climbed by >= 0.10
  reachesStorm: boolean;
}

export function lookahead(storm: AnalysedStorm, dp: DecisionPoint): Lookahead {
  const series = storm.signals[dp.corridor];
  const now = series[dp.second].risk;
  let futureMax = -Infinity;
  const end = Math.min(storm.seconds - 1, dp.second + LOOKAHEAD_SECONDS);
  for (let s = dp.second + 1; s <= end; s++) futureMax = Math.max(futureMax, series[s].risk);
  return {
    now,
    futureMax,
    worse: futureMax - now >= WORSE_BY,
    reachesStorm: futureMax >= UP_TO_STORM,
  };
}

export interface Judgement {
  result: Outcome;
  reason: string;
}

export function judge(storm: AnalysedStorm, dp: DecisionPoint, action: Action): Judgement {
  const la = lookahead(storm, dp);
  if (la.worse) {
    switch (action) {
      case "hold":
        return { result: "poor", reason: "Risk climbed soon after and you were unprotected." };
      case "hedge":
        return { result: "good", reason: "Risk climbed soon after and your protection paid off." };
      case "reduce":
        return la.reachesStorm
          ? { result: "good", reason: "A full storm hit soon after, so cutting back was worth it." }
          : { result: "poor", reason: "It wobbled but never stormed, so cutting back was an overreaction." };
    }
  }
  switch (action) {
    case "hold":
      return { result: "good", reason: "The worst was already passing, so staying put was right." };
    case "hedge":
      return { result: "poor", reason: "Protection costs most at the scariest moment, and risk then fell." };
    case "reduce":
      return { result: "poor", reason: "Risk fell soon after, so you sold near the worst moment." };
  }
}
