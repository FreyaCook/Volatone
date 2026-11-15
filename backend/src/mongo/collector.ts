// Builds the one-document-per-run record from the engine's event stream, in memory.
// Pure (no database, no timers). Independent of Tiger Data, but uses Tiger's run id when it is on.
import { randomUUID } from "node:crypto";
import type { Action, AgentName, Corridor, Outcome, VolatoneEvent } from "@volatone/shared";

export interface RunMove {
  corridor: Corridor;
  action: Action;
  outcome: Outcome | null;
  reason: string | null;
  agentsShowed: { agent: AgentName; action: Action }[];
}

export interface RunDoc {
  runId: string;
  scenario: string;
  seed: number | null;
  speed: number;
  startedAt: Date;
  finishedAt: Date;
  moves: RunMove[];
  peakRisk: Partial<Record<Corridor, number>>;
  agentViewCount: number;
  solana: { batches: number; confirmedBatches: number; failedBatches: number; meanConfirmMs: number | null };
}

export interface CollectorDeps {
  scenario: string;
  seed: number | null;
  speed: () => number;
  /** the last replay second; the run is finished when a tick at that second arrives */
  lastSecond: number;
  /** Tiger Data's current run id, if Tiger is on, so both stores use the same id */
  sharedRunId?: () => string | null;
  now?: () => Date;
  newId?: () => string;
}

export class RunCollector {
  runId: string | null = null;
  finished = false;
  private startedAt = new Date(0);
  private finishedAt = new Date(0);
  private speed = 1;
  private peak: Partial<Record<Corridor, number>> = {};
  private views = 0;
  private latest = new Map<string, { agent: AgentName; action: Action }>(); // "agent|corridor"
  private moves: (RunMove & { id: string })[] = [];
  private known = new Set<string>(); // ids of events logged in this run
  private confirmed: number[] = [];
  private failed = 0;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: CollectorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Engine listener. Synchronous and cheap. */
  onEvent = (e: VolatoneEvent): void => {
    if (e.type === "reset" || (e.type === "tick" && this.runId === null && e.t === 0)) {
      this.runId = this.deps.sharedRunId?.() ?? this.newId();
      this.startedAt = this.now();
      this.speed = e.type === "reset" && e.speed ? e.speed : this.deps.speed();
      this.peak = {};
      this.views = 0;
      this.latest.clear();
      this.moves = [];
      this.known.clear();
      this.confirmed = [];
      this.failed = 0;
      this.finished = false;
      if (e.type === "reset") return;
    }
    if (this.runId === null) return;

    switch (e.type) {
      case "tick":
        this.peak[e.corridor] = Math.max(this.peak[e.corridor] ?? 0, e.risk);
        if (!this.finished && e.t >= this.deps.lastSecond * 1000) {
          this.finished = true;
          this.finishedAt = this.now();
        }
        break;
      case "agent_decision":
        this.views++;
        this.known.add(e.id);
        this.latest.set(`${e.agent}|${e.corridor}`, { agent: e.agent, action: e.action });
        break;
      case "player_move": {
        this.known.add(e.id);
        const agentsShowed = [...this.latest.entries()].filter(([k]) => k.endsWith(`|${e.corridor}`)).map(([, v]) => v);
        this.moves.push({ id: e.id, corridor: e.corridor, action: e.action, outcome: null, reason: null, agentsShowed });
        break;
      }
      case "player_outcome": {
        this.known.add(e.id);
        const m = this.moves.find((x) => x.id === e.moveId);
        if (m) { m.outcome = e.result; m.reason = e.reason; }
        break;
      }
      case "tx_confirmed":
        if (e.eventIds.some((id) => this.known.has(id))) this.confirmed.push(e.confirmMs);
        break;
      case "tx_failed":
        if (e.eventIds.some((id) => this.known.has(id))) this.failed++;
        break;
    }
  }

  /** The document for the current run as it stands now. */
  build(): RunDoc {
    const mean = this.confirmed.length ? Math.round(this.confirmed.reduce((a, b) => a + b, 0) / this.confirmed.length) : null;
    return {
      runId: this.runId ?? "",
      scenario: this.deps.scenario,
      seed: this.deps.seed,
      speed: this.speed,
      startedAt: this.startedAt,
      finishedAt: this.finished ? this.finishedAt : this.now(),
      moves: this.moves.map(({ id: _id, ...m }) => m),
      peakRisk: Object.fromEntries(Object.entries(this.peak).map(([c, v]) => [c, Math.round((v as number) * 1000) / 1000])),
      agentViewCount: this.views,
      solana: { batches: this.confirmed.length + this.failed, confirmedBatches: this.confirmed.length, failedBatches: this.failed, meanConfirmMs: mean },
    };
  }
}
