// Wires Tiger Data into the backend. Returns null when it is switched off.
import type { VolatoneEvent } from "@volatone/shared";
import type { ReportMessage } from "@volatone/shared/protocol";
import { createPool, tigerEnabled } from "./config";
import { logOnce, safeError } from "./queue";
import { offReport, queryReport, unavailableReport } from "./report";
import { TigerWriter } from "./writer";

export interface Tiger {
  onEvent: (e: VolatoneEvent) => void;
  /** The current run's id (shared with the MongoDB record), null before the first run. */
  runId: () => string | null;
  /** Flush what is queued, then read the report back. Never throws; status says what happened. */
  report: () => Promise<ReportMessage>;
  stop: () => Promise<void>;
  status: () => { queued: number; dropped: number; written: number; breakerOpen: boolean; aggregate: string | null };
}

export function createTiger(
  env: NodeJS.ProcessEnv,
  info: { scenario: string; seed: number | null; speed: () => number },
  log: (m: string) => void,
): Tiger | null {
  if (!tigerEnabled(env)) return null;
  const url = env.TIGER_DATABASE_URL!.trim();
  const note = logOnce(log);
  let password = "";
  try { password = decodeURIComponent(new URL(url).password); } catch { /* not a URL: nothing to redact separately */ }
  const secrets = [url, password];
  const pool = createPool(url, (e) => note(`tiger: connection error (${safeError(e, secrets)})`));
  const writer = new TigerWriter(pool, info, note, secrets);
  writer.start();

  return {
    onEvent: writer.onEvent,
    runId: () => writer.runId,
    stop: () => writer.stop(),
    status: () => ({ queued: writer.queue.size, dropped: writer.queue.dropped, written: writer.written, breakerOpen: writer.breaker.isOpen, aggregate: writer.schema?.aggregate ?? null }),
    async report() {
      try {
        const runId = writer.runId;
        if (!runId) return unavailableReport();
        await writer.drain();
        if (!writer.schema || writer.queue.size > 0 || writer.schema.aggregate === "none") return unavailableReport();
        return await queryReport(pool, runId, writer.schema.aggregate);
      } catch (e) {
        note(`tiger: report failed (${safeError(e, secrets)})`);
        return unavailableReport();
      }
    },
  };
}

export { offReport };
