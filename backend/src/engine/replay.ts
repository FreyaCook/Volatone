// The replay engine: plays the storm one replay second per tick and turns it into events.
//
//  States: idle -> running -> finished. start() begins a run; reset() (or start() when finished)
//  emits "reset" and restarts from t = 0. Event ids never restart.
//
//  Each replay second s (0..last), in this order:
//    1. one tick per corridor (corridor order)
//    2. any escalations at s
//    3. the agent decisions planned for s (planAgentDecisions, explanation from cache or fallback)
//    4. any player_outcome due at s
//    5. a prompt closes at its second + PROMPT_SECONDS; a prompt opens at a decision point's second
//  A player_move is accepted only while that corridor's prompt is open, once per prompt. It is
//  judged at once with judge() (which only looks at storm data), but the player_outcome is emitted
//  when the look-ahead window ends (prompt second + LOOKAHEAD_SECONDS), so the result is never
//  revealed before the storm has shown it. A missed prompt logs nothing.
//
//  Batching: every agent_decision, player_move and player_outcome goes to the Batcher. A player move
//  is sent at once (the Batcher's rule); otherwise a timer every FLUSH_CHECK_MS asks it what is due.
//  Results come back from the Sender as tx_confirmed / tx_failed. With no Sender (CHAIN=off) nothing
//  is batched or sent. On reset, whatever is waiting is flushed and sent first.

import type {
  Action,
  AgentDecisionEvent,
  Corridor,
  PlayerMoveEvent,
  PlayerOutcomeEvent,
  VolatoneEvent,
} from "@volatone/shared";
import { explanationKey } from "../agents/explanations";
import { planAgentDecisions, toEvent, type PlannedDecision } from "../agents/runner";
import { Batcher, type Batch, type LoggableEvent } from "../chain/batcher";
import type { Sender } from "../chain/sender";
import { createIdSource, type IdSource } from "../ids";
import { loadStorm } from "../storm/committed";
import { judge, LOOKAHEAD_SECONDS, PROMPT_SECONDS, type Judgement } from "../storm/outcome";
import { CORRIDORS, type AnalysedStorm, type DecisionPoint, type Escalation } from "../storm/storm";
import { realClock, type Clock, type TimerHandle } from "./clock";

export type ReplayState = "idle" | "running" | "finished";

/** How often the Batcher is asked what is due. */
export const FLUSH_CHECK_MS = 250;


export interface EngineOptions {
  storm?: AnalysedStorm;
  clock?: Clock;
  /** Real ms per replay second (default 1000). */
  tickMs?: number;
  /** null = CHAIN=off: no batching, no tx events. */
  sender?: Sender | null;
  ids?: IdSource;
  /** Cached explanations by explanationKey(); anything missing uses the plain-English fallback. */
  explanations?: ReadonlyMap<string, string>;
  /** Called with a short message when something is ignored (bad timing, etc.). */
  log?: (msg: string) => void;
}

export type MoveResult = { ok: true; event: PlayerMoveEvent } | { ok: false; reason: string };

interface PendingOutcome {
  dueSecond: number;
  moveId: string;
  judgement: Judgement;
}

export class ReplayEngine {
  readonly storm: AnalysedStorm;
  readonly lastSecond: number;
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly sender: Sender | null;
  private readonly ids: IdSource;
  private readonly explanations: ReadonlyMap<string, string>;
  private readonly log: (msg: string) => void;
  private readonly plan: PlannedDecision[];

  private _state: ReplayState = "idle";
  private second = -1;          // last replay second emitted in this run
  private lastTickAt = 0;       // clock time of that second
  private runHistory: VolatoneEvent[] = [];
  private openPrompt: { dp: DecisionPoint; answered: boolean } | null = null;
  private outcomes: PendingOutcome[] = [];
  private batcher = new Batcher();
  private inflight = new Set<Promise<void>>();
  private listeners = new Set<(e: VolatoneEvent) => void>();
  private tickTimer: TimerHandle | null = null;
  private flushTimer: TimerHandle | null = null;

  constructor(opts: EngineOptions = {}) {
    this.storm = opts.storm ?? loadStorm();
    this.lastSecond = this.storm.seconds - 1;
    this.clock = opts.clock ?? realClock;
    this.tickMs = opts.tickMs ?? 1000;
    this.sender = opts.sender ?? null;
    this.ids = opts.ids ?? createIdSource();
    this.explanations = opts.explanations ?? new Map();
    this.log = opts.log ?? (() => {});
    this.plan = planAgentDecisions(this.storm);
    if (this.sender) this.flushTimer = this.clock.setInterval(() => this.flushDue(), FLUSH_CHECK_MS);
  }

  get state(): ReplayState {
    return this._state;
  }

  /** Every event since the current run began (what a late joiner is sent). */
  history(): readonly VolatoneEvent[] {
    return this.runHistory;
  }

  /** The prompt open right now, if any. */
  prompt(): DecisionPoint | null {
    return this.openPrompt?.dp ?? null;
  }

  subscribe(fn: (e: VolatoneEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Replay ms in the current run: the current second plus time since it ticked (capped at one second while running). */
  replayT(): number {
    if (this.second < 0) return 0;
    const since = ((this.clock.now() - this.lastTickAt) * 1000) / this.tickMs;
    return Math.round(this.second * 1000 + (this._state === "running" ? Math.min(999, since) : since));
  }

  start(): void {
    if (this._state === "running") return this.log("start ignored: already running");
    if (this._state === "finished") return this.reset();
    this.beginRun(false);
  }

  reset(): void {
    this.beginRun(true);
  }

  playerMove(corridor: Corridor, action: Action): MoveResult {
    const p = this.openPrompt;
    const refuse = (reason: string): MoveResult => (this.log(`player_move ignored: ${reason}`), { ok: false, reason });
    if (this._state !== "running") return refuse(`replay is ${this._state}`);
    if (!p) return refuse("no prompt is open");
    if (p.dp.corridor !== corridor) return refuse(`the open prompt is for ${p.dp.corridor}, not ${corridor}`);
    if (p.answered) return refuse("this prompt was already answered");
    p.answered = true;

    const event: PlayerMoveEvent = { id: this.ids.next(), t: this.replayT(), type: "player_move", corridor, action };
    this.emit(event);
    this.outcomes.push({
      dueSecond: Math.min(this.lastSecond, p.dp.second + LOOKAHEAD_SECONDS),
      moveId: event.id,
      judgement: judge(this.storm, p.dp, action),
    });
    this.queue(event);
    return { ok: true, event };
  }

  /** Resolves once every send started so far has reported back (for tests and clean shutdown). */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Stops all timers. Pending events stay unsent. */
  stop(): void {
    if (this.tickTimer !== null) this.clock.clearInterval(this.tickTimer);
    if (this.flushTimer !== null) this.clock.clearInterval(this.flushTimer);
    this.tickTimer = this.flushTimer = null;
  }

  // ---------- internals ----------

  private beginRun(withReset: boolean): void {
    if (this.tickTimer !== null) this.clock.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.openPrompt = null;
    this.outcomes = [];
    this.runHistory = [];
    this.second = -1;
    if (withReset) {
      this.sendBatches(this.batcher.flushAll()); // every announced event is still logged
      this.emit({ id: this.ids.next(), t: 0, type: "reset" });
    }
    this._state = "running";
    this.playSecond(0);
    this.tickTimer = this.clock.setInterval(() => this.playSecond(this.second + 1), this.tickMs);
  }

  private playSecond(s: number): void {
    this.second = s;
    this.lastTickAt = this.clock.now();
    const t = s * 1000;

    for (const corridor of CORRIDORS) {
      const sig = this.storm.signals[corridor][s];
      this.emit({ id: this.ids.next(), t, type: "tick", corridor, risk: Math.round(sig.risk * 1000) / 1000, state: sig.state });
    }
    for (const e of this.escalationsAt(s)) {
      this.emit({ id: this.ids.next(), t, type: "escalation", corridor: e.corridor, from: e.from, to: e.to });
    }
    for (const d of this.plan) {
      if (d.second !== s) continue;
      const ev: AgentDecisionEvent = toEvent(d, this.ids.next(), this.explanations.get(explanationKey(d)));
      this.emit(ev);
      this.queue(ev);
    }
    for (const o of this.outcomes.filter((x) => x.dueSecond === s)) {
      const ev: PlayerOutcomeEvent = {
        id: this.ids.next(), t, type: "player_outcome", moveId: o.moveId, result: o.judgement.result, reason: o.judgement.reason,
      };
      this.emit(ev);
      this.queue(ev);
    }
    this.outcomes = this.outcomes.filter((x) => x.dueSecond !== s);

    if (this.openPrompt && s >= this.openPrompt.dp.second + PROMPT_SECONDS) this.openPrompt = null;
    const dp = this.storm.data.decisionPoints.find((x) => x.second === s);
    if (dp) this.openPrompt = { dp, answered: false };

    if (s >= this.lastSecond) {
      this._state = "finished";
      this.openPrompt = null;
      if (this.tickTimer !== null) this.clock.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private escalationsAt(s: number): Escalation[] {
    return this.storm.escalations.filter((e) => e.second === s);
  }

  private emit(e: VolatoneEvent): void {
    this.runHistory.push(e);
    for (const fn of this.listeners) fn(e);
  }

  /** Queue a loggable event with the Batcher (no-op when CHAIN=off). */
  private queue(e: LoggableEvent): void {
    if (!this.sender) return;
    this.sendBatches(this.batcher.push(e, this.clock.now()));
  }

  private flushDue(): void {
    this.sendBatches(this.batcher.due(this.clock.now()));
  }

  private sendBatches(batches: Batch[]): void {
    const sender = this.sender;
    if (!sender) return;
    for (const batch of batches) {
      const p: Promise<void> = sender
        .send(batch, this.ids, () => this.replayT())
        .then(
          (r) => {
            if (r.programError) this.log(`program path failed (${r.programError}); logged via memo`);
            this.emit(r.event);
          },
          (err) => {
            // The Sender contract says it never throws; if one does, still report honestly.
            const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
            this.emit({ id: this.ids.next(), t: this.replayT(), type: "tx_failed", eventIds: batch.map((e) => e.id), error });
          },
        )
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }
}
