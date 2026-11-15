// The MongoDB store. Writes happen once per run, in the background; nothing on the replay's path
// awaits it. A failed write is retried once after 5 s, then dropped with one log line. A circuit
// breaker stops trying for 30 s after 3 failures in a row. Every method resolves, never throws.
import type { Collection } from "mongodb";
import type { RunSummary, RunsMessage } from "@volatone/shared/protocol";
import { CircuitBreaker, logOnce, safeError } from "../tiger/queue";
import type { RunDoc } from "./collector";

export const RECENT_LIMIT = 10;
const OP_TIMEOUT_MS = 6000;

/** The small part of a Mongo collection this store uses (the driver's Collection satisfies it). */
export interface RunsCollection {
  updateOne(filter: object, update: object, options: object): Promise<unknown>;
  createIndex(spec: object): Promise<unknown>;
  find(filter: object, options: object): { sort(s: object): { limit(n: number): { toArray(): Promise<unknown[]> } } };
}

/** Pure: a stored document (only the projected fields are needed) to the small summary the UI shows. */
export function summarise(doc: {
  runId: string; finishedAt: Date | string; speed: number;
  moves?: { outcome?: string | null }[]; peakRisk?: Record<string, number>; solana?: { confirmedBatches?: number };
}): RunSummary {
  const moves = doc.moves ?? [];
  const peaks = Object.values(doc.peakRisk ?? {});
  return {
    runId: String(doc.runId),
    finishedAt: new Date(doc.finishedAt).toISOString(),
    speed: Number(doc.speed),
    goodCalls: moves.filter((m) => m.outcome === "good").length,
    moves: moves.length,
    peakRisk: peaks.length ? Math.round(Math.max(...peaks) * 1000) / 1000 : 0,
    confirmedBatches: Number(doc.solana?.confirmedBatches ?? 0),
  };
}

/** Only these fields are read back for the list. */
export const RECENT_PROJECTION = { _id: 0, runId: 1, finishedAt: 1, speed: 1, "moves.outcome": 1, peakRisk: 1, "solana.confirmedBatches": 1 };

export const unavailableRuns = (): RunsMessage => ({ type: "runs", status: "unavailable" });
export const offRuns = (): RunsMessage => ({ type: "runs", status: "off" });

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("operation timed out")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export class MongoStore {
  readonly breaker = new CircuitBreaker(3, 30_000);
  private readonly note: (m: string) => void;
  private indexed = false;
  saved = 0;
  dropped = 0;

  constructor(
    private readonly getCollection: () => Promise<RunsCollection>,
    log: (m: string) => void,
    private readonly secrets: string[] = [],
    private readonly retryMs = 5000,
  ) {
    this.note = logOnce(log);
  }

  /** Writes (upserts by runId). In the background: the caller does not need to await it. `onSaved` runs after a success. */
  async saveRun(doc: RunDoc, onSaved?: () => void): Promise<boolean> {
    if (await this.tryWrite(doc)) { onSaved?.(); return true; }
    // Keep the in-memory copy and retry once.
    setTimeout(async () => {
      if (await this.tryWrite(doc)) onSaved?.();
      else {
        this.dropped++;
        this.note("mongo: run record dropped after one retry; the replay is unaffected");
      }
    }, this.retryMs).unref();
    return false;
  }

  private async tryWrite(doc: RunDoc): Promise<boolean> {
    if (!this.breaker.canTry(Date.now())) return false;
    try {
      const c = await this.getCollection();
      await withTimeout(this.ensureIndex(c), OP_TIMEOUT_MS);
      await withTimeout(c.updateOne({ runId: doc.runId }, { $set: doc }, { upsert: true }), OP_TIMEOUT_MS);
      this.breaker.success();
      this.saved++;
      return true;
    } catch (e) {
      this.breaker.failure(Date.now());
      this.note(`mongo: write failed (${safeError(e, this.secrets)})`);
      return false;
    }
  }

  private async ensureIndex(c: RunsCollection): Promise<void> {
    if (this.indexed) return;
    try { await c.createIndex({ finishedAt: -1 }); this.indexed = true; } catch { /* nice to have */ }
  }

  /** The last 10 runs, newest first. Never throws: status says what happened. */
  async recentRuns(): Promise<RunsMessage> {
    if (!this.breaker.canTry(Date.now())) return unavailableRuns();
    try {
      const c = await this.getCollection();
      const docs = await withTimeout(c.find({}, { projection: RECENT_PROJECTION }).sort({ finishedAt: -1 }).limit(RECENT_LIMIT).toArray(), OP_TIMEOUT_MS);
      this.breaker.success();
      return { type: "runs", status: "ok", runs: (docs as Parameters<typeof summarise>[0][]).map(summarise) };
    } catch (e) {
      this.breaker.failure(Date.now());
      this.note(`mongo: read failed (${safeError(e, this.secrets)})`);
      return unavailableRuns();
    }
  }
}

export type { Collection };
