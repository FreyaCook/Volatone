// The committed storm file, analysed once. Kept separate from storm.ts so the
// generator script can use the analysis code before storm.json exists.

import stormJson from "./storm.json" with { type: "json" };
import { analyse, type AnalysedStorm, type StormData } from "./storm";

export const STORM: StormData = stormJson as StormData;

let cached: AnalysedStorm | undefined;
export function loadStorm(): AnalysedStorm {
  return (cached ??= analyse(STORM));
}
