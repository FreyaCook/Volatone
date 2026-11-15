// Mock mode only: clearly fake rows for the past-runs panel. (With the real backend they come from MongoDB.)
import type { RunsMessage } from "@volatone/shared/protocol";

export const MOCK_RUNS: RunsMessage = {
  type: "runs",
  status: "ok",
  runs: [
    { runId: "mock-2", finishedAt: "2026-01-01T12:00:00.000Z", speed: 3, goodCalls: 3, moves: 4, peakRisk: 0.97, confirmedBatches: 0 },
    { runId: "mock-1", finishedAt: "2026-01-01T11:30:00.000Z", speed: 1, goodCalls: 2, moves: 4, peakRisk: 0.97, confirmedBatches: 0 },
  ],
};

export const SPEED_NAME: Record<number, string> = { 1: "Normal", 2: "Fast (2x)", 3: "Rush (3x)" };

/** The line under the panel says where the list came from, or why there is none. */
export function pastRunsStatus(runs: RunsMessage | null, mock: boolean): string {
  if (mock) return "MOCK: not from MongoDB. These rows are made up.";
  if (!runs) return "Checking MongoDB for past runs…";
  if (runs.status === "unavailable") return "MongoDB unavailable. The replay is unaffected.";
  if (runs.status === "off") return "MongoDB switched off.";
  return "Run records stored in MongoDB Atlas.";
}

export const goodCallsText = (good: number, total: number) => `good calls: ${good} of ${total}`;
