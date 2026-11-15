// Pure: turns engine events into database rows. No database, no clock of its own.
import { randomUUID } from "node:crypto";
import type { Action, Corridor, VolatoneEvent } from "@volatone/shared";

export type Row =
  | { table: "runs"; run_id: string; scenario: string; seed: number | null; speed: number; started_at: string }
  | { table: "risk_ticks"; ts: string; run_id: string; corridor: string; replay_t: number; risk: number; state: string }
  | { table: "events"; ts: string; run_id: string; replay_t: number; kind: "agent_view" | "player_move" | "outcome"; actor: string; corridor: string; action: string | null; detail: string }
  | { table: "tx_log"; ts: string; run_id: string; replay_t: number; signature: string | null; events: number; confirm_ms: number | null; ok: boolean };

export interface MapperDeps {
  scenario: string;
  seed: number | null;
  speed: () => number;
  now?: () => Date;
  newId?: () => string;
}

export class RowMapper {
  runId: string | null = null;
  private eventRun = new Map<string, string>();
  private moves = new Map<string, { corridor: Corridor; action: Action }>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: MapperDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** Rows for one engine event (usually 0 or 1). A new run id starts at "reset", or at the first tick of a first run. */
  handle(e: VolatoneEvent): Row[] {
    const out: Row[] = [];
    const ts = this.now().toISOString();
    if (e.type === "reset" || (e.type === "tick" && this.runId === null && e.t === 0)) {
      this.runId = this.newId();
      this.moves.clear();
      if (this.eventRun.size > 5000) this.eventRun.clear();
      const speed = e.type === "reset" && e.speed ? e.speed : this.deps.speed();
      out.push({ table: "runs", run_id: this.runId, scenario: this.deps.scenario, seed: this.deps.seed, speed, started_at: ts });
      if (e.type === "reset") return out;
    }
    const run = this.runId;
    if (run === null) return out;

    switch (e.type) {
      case "tick":
        out.push({ table: "risk_ticks", ts, run_id: run, corridor: e.corridor, replay_t: e.t, risk: e.risk, state: e.state });
        break;
      case "agent_decision":
        this.eventRun.set(e.id, run);
        out.push({ table: "events", ts, run_id: run, replay_t: e.t, kind: "agent_view", actor: e.agent, corridor: e.corridor, action: e.action,
          detail: JSON.stringify({ id: e.id, risk: e.risk, explanation: e.explanation }) });
        break;
      case "player_move":
        this.eventRun.set(e.id, run);
        this.moves.set(e.id, { corridor: e.corridor, action: e.action });
        out.push({ table: "events", ts, run_id: run, replay_t: e.t, kind: "player_move", actor: "player", corridor: e.corridor, action: e.action,
          detail: JSON.stringify({ id: e.id }) });
        break;
      case "player_outcome": {
        this.eventRun.set(e.id, run);
        const m = this.moves.get(e.moveId);
        out.push({ table: "events", ts, run_id: run, replay_t: e.t, kind: "outcome", actor: "player", corridor: m?.corridor ?? "", action: m?.action ?? null,
          detail: JSON.stringify({ moveId: e.moveId, result: e.result, reason: e.reason }) });
        break;
      }
      case "tx_confirmed":
      case "tx_failed": {
        // A batch belongs to the run its events came from (a tx can arrive after a reset).
        const txRun = e.eventIds.map((id) => this.eventRun.get(id)).find(Boolean) ?? run;
        const ok = e.type === "tx_confirmed";
        out.push({ table: "tx_log", ts, run_id: txRun, replay_t: e.t, signature: ok ? e.signature : null, events: e.eventIds.length, confirm_ms: ok ? e.confirmMs : null, ok });
        break;
      }
    }
    return out;
  }
}
