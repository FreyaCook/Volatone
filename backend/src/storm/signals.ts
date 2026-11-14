// Plain-maths market signals, computed from one corridor's per-second prices.
// Every function is pure: same prices + same second => same number. All outputs are 0..1.

/** A 0.8% move within 5 seconds counts as maximum shock. */
export const SHOCK_FULL_MOVE = 0.008;
/** An average 1-second move of 0.2% counts as maximum jumpiness. */
export const JUMP_FULL_MOVE = 0.002;

export const SHOCK_WINDOW = 5;
export const JUMP_WINDOW = 10;
export const SLOW_JUMP_WINDOW = 30;
export const BOUNCE_WINDOW = 10;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** % change from second i-1 to second i (as a fraction, 0.001 = 0.1%). 0 at i = 0. */
export function ret(prices: readonly number[], i: number): number {
  if (i <= 0) return 0;
  return (prices[i] - prices[i - 1]) / prices[i - 1];
}

/** How big the move over the last 5 seconds was. */
export function shock(prices: readonly number[], i: number): number {
  const from = prices[Math.max(0, i - SHOCK_WINDOW)];
  return clamp01(Math.abs(prices[i] - from) / from / SHOCK_FULL_MOVE);
}

/**
 * How jumpy the price is: average size of the 1-second moves over the last `window` seconds.
 * Seconds before the start of the replay count as zero moves (keeps the window size fixed).
 */
export function jumpiness(prices: readonly number[], i: number, window = JUMP_WINDOW): number {
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) if (k >= 1) sum += Math.abs(ret(prices, k));
  return clamp01(sum / window / JUMP_FULL_MOVE);
}

/** Same as jumpiness, but over the last 30 seconds (the Strategist's slower view). */
export const slowJumpiness = (prices: readonly number[], i: number): number =>
  jumpiness(prices, i, SLOW_JUMP_WINDOW);

/**
 * How much of the last 10 seconds' biggest move has already been undone ("retracement").
 * 0 = still at the extreme (or no move), 1 = fully back to where the window started.
 */
export function bounceBack(prices: readonly number[], i: number): number {
  const s = Math.max(0, i - BOUNCE_WINDOW);
  const start = prices[s];
  let extreme = start;
  for (let k = s; k <= i; k++) {
    if (Math.abs(prices[k] - start) > Math.abs(extreme - start)) extreme = prices[k];
  }
  const move = extreme - start;
  if (move === 0) return 0;
  return clamp01((extreme - prices[i]) / move);
}

/** The risk shown on the map and used for escalations: average of shock and jumpiness. */
export const marketRisk = (prices: readonly number[], i: number): number =>
  (shock(prices, i) + jumpiness(prices, i)) / 2;
