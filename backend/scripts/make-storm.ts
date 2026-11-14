// Generates the synthetic storm: backend/src/storm/storm.json.
// Run with `npm run make-storm -w backend`. The output is committed, and the replay only ever
// reads the JSON, so nothing random happens at runtime.
//
// How it works, in plain words:
//  1. Hand-placed design: for each corridor, keyframes for the map risk we want over time,
//     which way the price leans, the 14 escalation moments, and what each agent should say
//     at each decision point.
//  2. Each second's price move has a fixed *shape*: lean + seeded random chop (+1 / -1).
//     The seed makes the chop identical on every run and every machine.
//  3. A small deterministic optimiser picks only the *size* of each move so that
//       - the storm state is right on every second (so escalations land on the exact seconds),
//       - each agent gives the designed action at each decision point,
//       - and the map risk follows the keyframe curve as closely as possible.
//  4. We re-analyse the rounded prices with the real replay code and refuse to write the
//     file unless the escalations match the design exactly.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Action, AgentName, Corridor, StormState } from "@volatone/shared";
import { bounceBack, jumpiness, marketRisk, shock, slowJumpiness } from "../src/storm/signals";
import {
  analyse,
  CORRIDORS,
  DOWN_FROM_STORM,
  DOWN_TO_CALM,
  UP_TO_SPREADING,
  UP_TO_STORM,
  type DecisionPoint,
  type StormData,
} from "../src/storm/storm";
import { THRESHOLDS, CADENCE_SECONDS } from "../src/agents/scoring";

const SEED = 20261114;
const SECONDS = 151; // t = 0..150 s
const OUT = fileURLToPath(new URL("../src/storm/storm.json", import.meta.url));

// ---------------------------------------------------------------------------
// 1. Hand-placed design
// ---------------------------------------------------------------------------

const START_PRICE: Record<Corridor, number> = {
  "USD-JPY": 150.0,
  "EUR-JPY": 162.0,
  "EUR-USD": 1.08,
  "GBP-USD": 1.27,
};
const DECIMALS: Record<Corridor, number> = { "USD-JPY": 3, "EUR-JPY": 3, "EUR-USD": 5, "GBP-USD": 5 };

/** Target map risk, [second, risk], linearly interpolated. A soft guide for the shape. */
const RISK_KEYFRAMES: Record<Corridor, [number, number][]> = {
  // Origin: a surprise policy signal from Tokyo. Yen jumps, USD-JPY falls hard.
  "USD-JPY": [
    [0, 0.08], [10, 0.12], [20, 0.37], [25, 0.47], [35, 0.72], [45, 0.85], [55, 0.92],
    [65, 0.88], [80, 0.75], [88, 0.69], [101, 0.62], [102, 0.58], [112, 0.45], [118, 0.38],
    [129, 0.32], [130, 0.29], [138, 0.2], [146, 0.12], [150, 0.1],
  ],
  // Yen strength spills into EUR-JPY.
  "EUR-JPY": [
    [0, 0.07], [30, 0.2], [44, 0.33], [45, 0.37], [55, 0.6], [60, 0.72], [70, 0.82],
    [80, 0.85], [88, 0.8], [95, 0.73], [102, 0.68], [111, 0.62], [112, 0.58], [118, 0.5],
    [124, 0.42], [130, 0.35], [137, 0.32], [138, 0.29], [146, 0.18], [150, 0.14],
  ],
  // Dollar and euro wobble. Sharp drop to ~91 s, sharp bounce, peak risk at 95 s.
  "EUR-USD": [
    [0, 0.06], [30, 0.08], [50, 0.18], [64, 0.33], [65, 0.37], [80, 0.6], [87, 0.68],
    [88, 0.72], [92, 0.83], [95, 0.88], [97, 0.84], [102, 0.79], [112, 0.71], [118, 0.66],
    [123, 0.62], [124, 0.58], [130, 0.48], [138, 0.38], [145, 0.32], [146, 0.29], [150, 0.24],
  ],
  // The pound only ever reaches "spreading": the corridor the agents argue about.
  "GBP-USD": [
    [0, 0.05], [40, 0.08], [60, 0.18], [72, 0.27], [79, 0.33], [80, 0.37], [88, 0.5],
    [95, 0.55], [102, 0.46], [112, 0.37], [117, 0.32], [118, 0.29], [124, 0.2],
    [130, 0.15], [138, 0.1], [150, 0.07],
  ],
};

/**
 * Which way the price leans, [fromSecond, lean] with lean from -1 to +1.
 * Each move = size x (lean + (1 - |lean|) x chop), where chop is a seeded +1 / -1.
 * -1 = falling steadily, 0 = choppy (back and forth), +1 = rising steadily.
 * Steady moves raise shock; choppy moves raise jumpiness without much shock.
 * Avoid |lean| = 0.5: half the moves would be exactly zero, and risk would saw-tooth.
 */
const LEAN: Record<Corridor, [number, number][]> = {
  // Storms swing both ways: the lean flips every ~8 s, so shock stays high but the
  // price doesn't keep sliding (real storms whipsaw rather than fall in a straight line).
  "USD-JPY": [[0, 0], [18, -0.9], [36, 0.6], [44, -0.6], [52, 0.6], [60, -0.6], [68, 0.6],
    [76, -0.6], [84, 0.6], [92, -0.6], [100, 0.4]],
  "EUR-JPY": [[0, 0], [42, -0.9], [56, 0.6], [64, -0.6], [72, 0.6], [80, -0.6], [90, 0.6],
    [100, -0.6], [112, 0.3], [126, 0.4]],
  "EUR-USD": [[0, 0], [62, -0.6], [73, 0.6], [81, -1], [92, 1], [97, -0.7], [105, 0.7],
    [114, -0.7], [124, 0.4]],
  "GBP-USD": [[0, 0], [60, -0.9], [96, 0.4]],
};

const DECISION_POINTS: DecisionPoint[] = [
  { id: "dp1", second: 25, corridor: "USD-JPY" },
  { id: "dp2", second: 72, corridor: "GBP-USD" },
  { id: "dp3", second: 95, corridor: "EUR-USD" },
  { id: "dp4", second: 132, corridor: "EUR-JPY" },
];

/** What each agent should say at each decision point (the disagreement table). */
const DESIGNED_AGENT_ACTIONS: Record<string, Record<AgentName, Action>> = {
  dp1: { sentinel: "hedge", opportunist: "hold", strategist: "hold" },
  dp2: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
  dp3: { sentinel: "reduce", opportunist: "hold", strategist: "reduce" },
  dp4: { sentinel: "hold", opportunist: "hold", strategist: "hedge" },
};

/**
 * Map-risk requirements that make each decision point's outcome clear-cut
 * ([corridor, fromSecond, toSecond, lo, hi]: risk must be >= lo and < hi on those seconds).
 */
const OUTCOME_BANDS: [Corridor, number, number, number, number][] = [
  // dp1: early wobble, a full storm follows (risk climbs well over 0.10).
  ["USD-JPY", 25, 25, 0.4, 0.55],
  // dp2: still calm, then climbs >= 0.10 but never storms.
  ["GBP-USD", 72, 72, 0.22, 0.3],
  ["GBP-USD", 85, 85, 0.43, 0.6],
  // dp3: the scariest moment; risk only falls for the next 15 s.
  ["EUR-USD", 95, 95, 0.86, 0.97],
  ["EUR-USD", 96, 110, -Infinity, 0.84],
  // dp4: fading; risk only falls for the next 15 s.
  ["EUR-JPY", 132, 132, 0.355, 0.385],
  ["EUR-JPY", 133, 147, -Infinity, 0.345],
];

/** The escalations the design promises, [second, corridor, to]. */
const DESIGNED_ESCALATIONS: [number, Corridor, StormState][] = [
  [20, "USD-JPY", "spreading"],
  [35, "USD-JPY", "storm"],
  [45, "EUR-JPY", "spreading"],
  [60, "EUR-JPY", "storm"],
  [65, "EUR-USD", "spreading"],
  [80, "GBP-USD", "spreading"],
  [88, "EUR-USD", "storm"],
  [102, "USD-JPY", "spreading"],
  [112, "EUR-JPY", "spreading"],
  [118, "GBP-USD", "calm"],
  [124, "EUR-USD", "spreading"],
  [130, "USD-JPY", "calm"],
  [138, "EUR-JPY", "calm"],
  [146, "EUR-USD", "calm"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small seeded PRNG (mulberry32): same seed => same sequence, on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function interp(keys: [number, number][], s: number): number {
  for (let k = 1; k < keys.length; k++) {
    const [s0, v0] = keys[k - 1];
    const [s1, v1] = keys[k];
    if (s <= s1) return v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
  }
  return keys[keys.length - 1][1];
}

function step(keys: [number, number][], s: number): number {
  let v = keys[0][1];
  for (const [from, val] of keys) if (s >= from) v = val;
  return v;
}

const round = (x: number, d: number): number => Number(x.toFixed(d));

/** The designed state of every corridor on every second, from the escalation list. */
function designedStates(): Record<Corridor, StormState[]> {
  const out = {} as Record<Corridor, StormState[]>;
  for (const c of CORRIDORS) {
    const states: StormState[] = [];
    let st: StormState = "calm";
    for (let s = 0; s < SECONDS; s++) {
      for (const [es, ec, to] of DESIGNED_ESCALATIONS) if (es === s && ec === c) st = to;
      states.push(st);
    }
    out[c] = states;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2-3. Constraints and optimiser
// ---------------------------------------------------------------------------

/** Keep this far inside every threshold so rounding prices can't flip a result. */
const MARGIN = 0.015;

type Quantity = "risk" | "sentinel" | "opportunist" | "slowJumpiness";
interface Band {
  second: number;
  q: Quantity;
  lo: number; // value must be >= lo
  hi: number; // value must be <  hi
}

function quantity(q: Quantity, p: number[], s: number): number {
  switch (q) {
    case "risk":
      return marketRisk(p, s);
    case "sentinel":
      return Math.max(shock(p, s), jumpiness(p, s));
    case "opportunist":
      return jumpiness(p, s) * (1 - bounceBack(p, s));
    case "slowJumpiness":
      return slowJumpiness(p, s);
  }
}

/** Score range that gives `action`, shrunk by MARGIN on each side. */
function actionBand(agent: AgentName, action: Action): [number, number] {
  const t = THRESHOLDS[agent];
  if (action === "hold") return [-Infinity, t.hedge - MARGIN];
  if (action === "hedge") return [t.hedge + MARGIN, t.reduce - MARGIN];
  return [t.reduce + MARGIN, Infinity];
}

function bandsFor(c: Corridor, states: Record<Corridor, StormState[]>): Band[] {
  const bands: Band[] = [];
  const st = states[c];
  // State on every second (one step per second with hysteresis, see nextState()).
  for (let s = 0; s < SECONDS; s++) {
    const prev = s === 0 ? "calm" : st[s - 1];
    const cur = st[s];
    let lo = -Infinity;
    let hi = Infinity;
    if (prev === "calm") {
      if (cur === "calm") hi = UP_TO_SPREADING;
      else lo = UP_TO_SPREADING;
    } else if (prev === "spreading") {
      if (cur === "spreading") [lo, hi] = [DOWN_TO_CALM, UP_TO_STORM];
      else if (cur === "storm") lo = UP_TO_STORM;
      else hi = DOWN_TO_CALM;
    } else {
      if (cur === "storm") lo = DOWN_FROM_STORM;
      else hi = DOWN_FROM_STORM;
    }
    bands.push({ second: s, q: "risk", lo: lo + MARGIN, hi: hi - MARGIN });
  }
  // Clear-cut outcomes at decision points (no extra margin: these are already inside).
  for (const [oc, from, to, lo, hi] of OUTCOME_BANDS) {
    if (oc !== c) continue;
    for (let s = from; s <= to; s++) bands.push({ second: s, q: "risk", lo, hi });
  }
  // Agent actions at this corridor's decision points.
  for (const dp of DECISION_POINTS.filter((d) => d.corridor === c)) {
    const want = DESIGNED_AGENT_ACTIONS[dp.id];
    const [sLo, sHi] = actionBand("sentinel", want.sentinel);
    bands.push({ second: dp.second, q: "sentinel", lo: sLo, hi: sHi });
    const [oLo, oHi] = actionBand("opportunist", want.opportunist);
    bands.push({ second: dp.second, q: "opportunist", lo: oLo, hi: oHi });
    // Strategist = 0.5 x slowJumpiness + 0.5 x contagion, scored on its own cadence.
    const e = dp.second - (dp.second % CADENCE_SECONDS.strategist);
    const contagion = CORRIDORS.filter((o) => o !== c && states[o][e] !== "calm").length / 3;
    const [gLo, gHi] = actionBand("strategist", want.strategist);
    bands.push({ second: e, q: "slowJumpiness", lo: 2 * gLo - contagion, hi: 2 * gHi - contagion });
  }
  return bands;
}

const BAND_WEIGHT = 20000;  // breaking a requirement costs far more than missing the curve
const OPT_PAD = 0.01;
const MAX_DRIFT = 0.035;         // soft limit: 3.5% from the start price
const END_FALL_ALLOWED = 0.001;  // at most a 0.1% fall over the last 10 s
const DRIFT_WEIGHT = 0.5;
const SMOOTH_WEIGHT = 0.005;    // prefer move sizes that change gradually
const RISK_SMOOTH_WEIGHT = 3;   // prefer map risk that doesn't jump around second to second
const SIZE_SCALE = 0.002;   // move sizes are compared in units of 0.2%

function buildPrices(start: number, shape: number[], size: number[]): number[] {
  const p = [start];
  for (let i = 1; i < SECONDS; i++) p.push(p[i - 1] * (1 + shape[i] * size[i]));
  return p;
}

function cost(
  p: number[], size: number[], target: number[], bandsAt: Band[][], from: number, to: number,
): number {
  let total = 0;
  let prev = from > 0 ? marketRisk(p, from - 1) : 0;
  for (let s = from; s <= to; s++) {
    const r = marketRisk(p, s);
    total += (r - target[s]) ** 2;
    if (s >= 1) total += RISK_SMOOTH_WEIGHT * (r - prev) ** 2;
    prev = r;
    for (const b of bandsAt[s]) {
      const v = b.q === "risk" ? r : quantity(b.q, p, s);
      // Aim OPT_PAD further inside than the final check needs, so results don't sit on the edge.
      if (v < b.lo + OPT_PAD) total += BAND_WEIGHT * (b.lo + OPT_PAD - v) ** 2;
      if (v > b.hi - OPT_PAD) total += BAND_WEIGHT * (v - b.hi + OPT_PAD) ** 2;
    }
    if (s >= 1) total += SMOOTH_WEIGHT * ((size[s] - size[s - 1]) / SIZE_SCALE) ** 2;
  }
  // Realism: stay within ~3.5% of the start price, and don't still be falling at the end.
  // (A move at `from` shifts every later price, so this looks at all of them.)
  for (let s = from; s < SECONDS; s++) {
    const away = Math.abs(Math.log(p[s] / p[0])) - MAX_DRIFT;
    if (away > 0) total += DRIFT_WEIGHT * (away / 0.01) ** 2;
  }
  const endFall = (p[SECONDS - 11] - p[SECONDS - 1]) / p[SECONDS - 11] - END_FALL_ALLOWED;
  if (endFall > 0) total += DRIFT_WEIGHT * (endFall / 0.001) ** 2;
  return total;
}

/** Signals look back at most 30 s, so changing move s only affects seconds s..s+30. */
const REACH = 31;
const FACTORS = [0, 0.3, 0.6, 0.8, 0.9, 0.96, 0.99, 1.01, 1.04, 1.1, 1.25, 1.6, 2.5];
const SWEEPS = 300;

function optimiseCorridor(c: Corridor, rand: () => number, states: Record<Corridor, StormState[]>) {
  // Shapes: lean + seeded chop.
  const shape = [0];
  let chop = 1;
  for (let i = 1; i < SECONDS; i++) {
    chop = rand() < 0.25 ? chop : -chop; // usually flips, sometimes repeats
    const lean = step(LEAN[c], i);
    shape.push(lean + (1 - Math.abs(lean)) * chop);
  }
  const target = Array.from({ length: SECONDS }, (_, s) => interp(RISK_KEYFRAMES[c], s));
  const bandsAt: Band[][] = Array.from({ length: SECONDS }, () => []);
  for (const b of bandsFor(c, states)) bandsAt[b.second].push(b);

  // Starting guess: the steady-state size for each second's target risk.
  const size = shape.map((_, i) => {
    const L = Math.abs(step(LEAN[c], i));
    const riskPerSize = (625 * L + 500 * Math.max(L, 1 - L)) / 2;
    return i === 0 ? 0 : target[i] / riskPerSize;
  });

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let i = 1; i < SECONDS; i++) {
      const to = Math.min(SECONDS - 1, i + REACH);
      const base = size[i];
      let bestSize = base;
      let bestCost = cost(buildPrices(START_PRICE[c], shape, size), size, target, bandsAt, i, to);
      const candidates = FACTORS.map((f) => base * f);
      if (base === 0) candidates.push(0.0002, 0.0005, 0.001);
      for (const cand of candidates) {
        size[i] = cand;
        const k = cost(buildPrices(START_PRICE[c], shape, size), size, target, bandsAt, i, to);
        if (k < bestCost - 1e-12) [bestCost, bestSize] = [k, cand];
      }
      size[i] = bestSize;
    }
  }

  const prices = buildPrices(START_PRICE[c], shape, size).map((x) => round(x, DECIMALS[c]));
  if (process.env.DIAG === c) {
    for (let s = 1; s < SECONDS; s++) {
      console.log(s, "size", (size[s] * 100).toFixed(3) + "%", "shape", shape[s].toFixed(2),
        "risk", marketRisk(prices, s).toFixed(3), "target", target[s].toFixed(3),
        "shock", shock(prices, s).toFixed(2), "jump", jumpiness(prices, s).toFixed(2));
    }
  }
  const broken = bandsFor(c, states).filter((b) => {
    const v = quantity(b.q, prices, b.second);
    return v < b.lo || v >= b.hi; // strict: the safety margin must survive rounding
  });
  let worstGap = 0;
  for (let s = 0; s < SECONDS; s++) worstGap = Math.max(worstGap, Math.abs(marketRisk(prices, s) - target[s]));
  return { prices, broken, worstGap };
}

// ---------------------------------------------------------------------------
// 4. Build, verify, write
// ---------------------------------------------------------------------------

/** Start, low, end, total change, biggest peak-to-trough drop, change over the last 10 s. */
export function realism(p: number[]): string {
  let peak = p[0];
  let drop = 0;
  for (const x of p) {
    peak = Math.max(peak, x);
    drop = Math.max(drop, (peak - x) / peak);
  }
  const pct = (a: number, b: number) => (((b - a) / a) * 100).toFixed(2) + "%";
  return `start ${p[0]}, low ${Math.min(...p)}, end ${p[p.length - 1]}, total ${pct(p[0], p[p.length - 1])}, ` +
    `biggest drop ${(drop * 100).toFixed(2)}%, last 10 s ${pct(p[p.length - 11], p[p.length - 1])}`;
}

function main(): void {
  const rand = mulberry32(SEED);
  const states = designedStates();
  const prices = {} as Record<Corridor, number[]>;
  let ok = true;
  for (const c of CORRIDORS) {
    const r = optimiseCorridor(c, rand, states);
    prices[c] = r.prices;
    console.log(`${c}: largest gap from the target curve = ${r.worstGap.toFixed(3)}, broken requirements = ${r.broken.length}`);
    console.log(`   ${realism(r.prices)}`);
    for (const b of r.broken) {
      console.log(`   second ${b.second} ${b.q} = ${quantity(b.q, r.prices, b.second).toFixed(3)}, wanted [${b.lo.toFixed(3)}, ${b.hi.toFixed(3)})`);
      ok = false;
    }
  }

  const data: StormData = {
    name: "Tokyo surprise (synthetic)",
    source: "synthetic",
    seed: SEED,
    stepMs: 1000,
    prices,
    decisionPoints: DECISION_POINTS,
  };

  const got = analyse(data).escalations.map((e) => `${e.second} ${e.corridor} -> ${e.to}`);
  const want = DESIGNED_ESCALATIONS.map(([s, c, to]) => `${s} ${c} -> ${to}`);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error("Escalations do not match the design. Got:\n  " + got.join("\n  "));
    ok = false;
  }
  if (!ok) {
    console.error("Not writing storm.json.");
    process.exit(1);
  }

  // One corridor per line keeps the file readable and diffs small.
  const lines = CORRIDORS.map((c) => `    "${c}": ${JSON.stringify(prices[c])}`).join(",\n");
  const json =
    `{\n  "name": ${JSON.stringify(data.name)},\n  "source": "synthetic",\n  "seed": ${SEED},\n` +
    `  "stepMs": 1000,\n  "prices": {\n${lines}\n  },\n` +
    `  "decisionPoints": [\n${DECISION_POINTS.map((d) => "    " + JSON.stringify(d)).join(",\n")}\n  ]\n}\n`;
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT}: ${got.length} escalations at the designed seconds.`);
}

main();
