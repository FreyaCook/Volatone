// Loads the storm data and derives everything the replay needs from the prices alone:
// per-second signals, map risk, storm states and escalations. Deterministic by construction.

import type { Corridor, StormState } from "@volatone/shared";
import { bounceBack, jumpiness, marketRisk, shock, slowJumpiness } from "./signals";

export const CORRIDORS: readonly Corridor[] = ["USD-JPY", "EUR-JPY", "EUR-USD", "GBP-USD"];

/** A moment where the player is asked to hedge, hold or reduce. */
export interface DecisionPoint {
  id: string;
  second: number;      // replay second the prompt opens
  corridor: Corridor;
}

/** The plain-data storm file. Real exchange data can replace it if it keeps this shape. */
export interface StormData {
  name: string;
  source: "synthetic" | "sgx";
  seed: number | null;   // generator seed (synthetic only)
  stepMs: number;        // time between price samples in replay time
  prices: Record<Corridor, number[]>; // one price per step, same length for every corridor
  decisionPoints: DecisionPoint[];
}

// Hysteresis: risk must fall a bit lower to step down than it needed to step up.
export const UP_TO_SPREADING = 0.35;
export const UP_TO_STORM = 0.7;
export const DOWN_FROM_STORM = 0.6;
export const DOWN_TO_CALM = 0.3;

/** Move at most one state per second, with hysteresis. */
export function nextState(state: StormState, risk: number): StormState {
  switch (state) {
    case "calm":
      return risk >= UP_TO_SPREADING ? "spreading" : "calm";
    case "spreading":
      if (risk >= UP_TO_STORM) return "storm";
      if (risk < DOWN_TO_CALM) return "calm";
      return "spreading";
    case "storm":
      return risk < DOWN_FROM_STORM ? "spreading" : "storm";
  }
}

export interface Signals {
  shock: number;
  jumpiness: number;
  slowJumpiness: number;
  bounceBack: number;
  risk: number;        // map / market risk
  state: StormState;
}

export interface Escalation {
  second: number;
  corridor: Corridor;
  from: StormState;
  to: StormState;
}

export interface AnalysedStorm {
  data: StormData;
  seconds: number;                              // number of samples (last index = seconds - 1)
  signals: Record<Corridor, Signals[]>;         // [corridor][second]
  escalations: Escalation[];                    // in time order, then corridor order
  /** Share of the OTHER three corridors that are not calm at this second (0, 1/3, 2/3, 1). */
  contagion(corridor: Corridor, second: number): number;
}

export function analyse(data: StormData): AnalysedStorm {
  const seconds = data.prices[CORRIDORS[0]].length;
  for (const c of CORRIDORS) {
    if (data.prices[c]?.length !== seconds) throw new Error(`storm: ${c} has wrong number of prices`);
  }

  const signals = {} as Record<Corridor, Signals[]>;
  const escalations: Escalation[] = [];
  for (const c of CORRIDORS) {
    const p = data.prices[c];
    const out: Signals[] = [];
    let state: StormState = "calm";
    for (let i = 0; i < seconds; i++) {
      const risk = marketRisk(p, i);
      const next = nextState(state, risk);
      if (next !== state) escalations.push({ second: i, corridor: c, from: state, to: next });
      state = next;
      out.push({
        shock: shock(p, i),
        jumpiness: jumpiness(p, i),
        slowJumpiness: slowJumpiness(p, i),
        bounceBack: bounceBack(p, i),
        risk,
        state,
      });
    }
    signals[c] = out;
  }
  escalations.sort(
    (a, b) => a.second - b.second || CORRIDORS.indexOf(a.corridor) - CORRIDORS.indexOf(b.corridor),
  );

  const contagion = (corridor: Corridor, second: number): number =>
    CORRIDORS.filter((o) => o !== corridor && signals[o][second].state !== "calm").length / 3;

  return { data, seconds, signals, escalations, contagion };
}
