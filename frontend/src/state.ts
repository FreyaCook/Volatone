// One pure reducer: the whole UI state is rebuilt from the event stream.
// A late join replays history first, so folding the same events in order always gives the same state.
import type {
  Action as MoveAction, AgentDecisionEvent, Corridor, PlayerMoveEvent, PlayerOutcomeEvent, StormState,
  TxConfirmedEvent, TxFailedEvent, VolatoneEvent,
} from "@volatone/shared";
import { DECISION_POINTS, PROMPT_SECONDS, REPLAY_LAST_SECOND } from "@volatone/shared/protocol";

export const CORRIDORS: readonly Corridor[] = ["USD-JPY", "EUR-JPY", "EUR-USD", "GBP-USD"];

export interface CorridorView { state: StormState; risk: number }
export type TxEvent = TxConfirmedEvent | TxFailedEvent;
export type FeedItem = AgentDecisionEvent | PlayerMoveEvent | PlayerOutcomeEvent;
export type RunStatus = "idle" | "running" | "finished";

export interface State {
  status: RunStatus;
  t: number; // ms, time of the latest tick in this run
  corridors: Record<Corridor, CorridorView>;
  decisions: AgentDecisionEvent[]; // newest first
  feed: FeedItem[]; // decisions, player moves and outcomes together, newest first
  indexSeries: number[]; // storm index (0..1, mean risk of the four corridors) by replay second, for the barograph
  sentinel: Partial<Record<Corridor, AgentDecisionEvent>>; // latest Sentinel decision per corridor
  moves: PlayerMoveEvent[];
  outcomes: Record<string, PlayerOutcomeEvent>; // by moveId
  txs: TxEvent[]; // newest first
  loggedIds: Record<string, true>; // ids of decision/move/outcome events seen in this run
}

export type Action =
  | { kind: "event"; event: VolatoneEvent }
  | { kind: "clear" }; // dispatched on every (re)connect: the server replays history

export function initialState(): State {
  const corridors = {} as Record<Corridor, CorridorView>;
  for (const c of CORRIDORS) corridors[c] = { state: "calm", risk: 0 };
  return { status: "idle", t: 0, corridors, decisions: [], feed: [], indexSeries: [], sentinel: {}, moves: [], outcomes: {}, txs: [], loggedIds: {} };
}

export function reduce(s: State, a: Action): State {
  if (a.kind === "clear") return initialState();
  const e = a.event;
  switch (e.type) {
    case "reset":
      // A reset restarts the run: everything clears. Late tx events for the old run are ignored below.
      return { ...initialState(), status: "running" };
    case "tick": {
      const corridors = { ...s.corridors, [e.corridor]: { state: e.state, risk: e.risk } };
      const indexSeries = s.indexSeries.slice();
      indexSeries[Math.round(e.t / 1000)] = stormIndexOf(corridors); // the last tick of a second wins
      return {
        ...s,
        t: e.t,
        status: e.t >= REPLAY_LAST_SECOND * 1000 ? "finished" : "running",
        corridors,
        indexSeries,
      };
    }
    case "escalation":
      // Ticks already carry the state; the escalation just makes the new state show at once.
      return { ...s, corridors: { ...s.corridors, [e.corridor]: { ...s.corridors[e.corridor], state: e.to } } };
    case "agent_decision":
      return {
        ...s,
        decisions: [e, ...s.decisions],
        feed: [e, ...s.feed],
        sentinel: e.agent === "sentinel" ? { ...s.sentinel, [e.corridor]: e } : s.sentinel,
        loggedIds: { ...s.loggedIds, [e.id]: true },
      };
    case "player_move":
      return { ...s, moves: [...s.moves, e], feed: [e, ...s.feed], loggedIds: { ...s.loggedIds, [e.id]: true } };
    case "player_outcome":
      return { ...s, outcomes: { ...s.outcomes, [e.moveId]: e }, feed: [e, ...s.feed], loggedIds: { ...s.loggedIds, [e.id]: true } };
    case "tx_confirmed":
    case "tx_failed":
      // Match by eventIds: a tx for the previous run (arriving after a reset) matches nothing here.
      if (!e.eventIds.some((id) => s.loggedIds[id])) return s;
      return { ...s, txs: [e, ...s.txs] };
  }
}

// ---- Prompts: not events. Derived from tick times (see shared/protocol.ts). ----

export type PromptStatus = "upcoming" | "open" | "answered" | "missed";
export interface PromptView {
  id: string;
  corridor: Corridor;
  opensT: number;
  closesT: number;
  status: PromptStatus;
  move?: PlayerMoveEvent;
  outcome?: PlayerOutcomeEvent;
}

export function promptViews(s: State): PromptView[] {
  return DECISION_POINTS.map((dp) => {
    const opensT = dp.second * 1000;
    const closesT = (dp.second + PROMPT_SECONDS) * 1000;
    const move = s.moves.find((m) => m.corridor === dp.corridor && m.t >= opensT && m.t <= closesT);
    let status: PromptStatus = "upcoming";
    if (s.status !== "idle") {
      if (move) status = "answered";
      else if (s.t >= closesT) status = "missed";
      else if (s.t >= opensT) status = "open";
    }
    return { id: dp.id, corridor: dp.corridor, opensT, closesT, status, move, outcome: move && s.outcomes[move.id] };
  });
}

/** The prompt the player can answer right now, if any. */
export function openPrompt(s: State): PromptView | undefined {
  return promptViews(s).find((p) => p.status === "open");
}

export function stormCount(s: State): number {
  return CORRIDORS.filter((c) => s.corridors[c].state === "storm").length;
}

const stormIndexOf = (c: Record<Corridor, CorridorView>) =>
  CORRIDORS.reduce((sum, k) => sum + c[k].risk, 0) / CORRIDORS.length;

/** Storm index 0..1: mean risk across the four corridors. */
export const stormIndex = (s: State) => stormIndexOf(s.corridors);

/** Worst state among the given corridors (storm > spreading > calm). */
export function worstState(s: State, corridors: readonly Corridor[]): StormState {
  const states = corridors.map((c) => s.corridors[c].state);
  return states.includes("storm") ? "storm" : states.includes("spreading") ? "spreading" : "calm";
}

/** The low-pressure system over Tokyo follows the worse of USD-JPY and EUR-JPY. */
export const cycloneRisk = (s: State) => Math.max(s.corridors["USD-JPY"].risk, s.corridors["EUR-JPY"].risk);

/** Whole replay seconds left in an open prompt (8 at the moment it opens, 1 on its last second). */
export function secondsLeft(s: State, p: PromptView): number {
  if (p.status !== "open") return 0;
  return Math.max(0, PROMPT_SECONDS - Math.floor((s.t - p.opensT) / 1000));
}

/** Autopilot (Rush only): the player's move is whatever Sentinel last said about that corridor. */
export function autopilotAction(s: State, corridor: Corridor): MoveAction {
  return s.sentinel[corridor]?.action ?? "hold";
}
