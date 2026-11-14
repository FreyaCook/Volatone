// shared/events.ts
// The one event format for Volatone. The replay engine, agents, Solana worker,
// WebSocket feed, map and music all use these types.

export type Corridor = "USD-JPY" | "EUR-JPY" | "EUR-USD" | "GBP-USD";

export type StormState = "calm" | "spreading" | "storm";
export type AgentName = "sentinel" | "opportunist" | "strategist";
export type Action = "hedge" | "hold" | "reduce";
export type Outcome = "good" | "poor";

interface BaseEvent {
  id: string; // "evt_0001". Unique across runs: do NOT restart the counter on reset
  t: number;  // ms since the current replay run started (restarts at 0 after reset)
}

/** Market state for one corridor. Drives map colour and music tension. */
export interface TickEvent extends BaseEvent {
  type: "tick";
  corridor: Corridor;
  risk: number;      // 0..1
  state: StormState;
}

/** One agent's scored decision. Written to devnet. */
export interface AgentDecisionEvent extends BaseEvent {
  type: "agent_decision";
  agent: AgentName;
  corridor: Corridor;
  risk: number;        // this agent's own score, 0..1
  action: Action;
  explanation: string; // Gemini text, or cached/fallback text
}

/** The player's choice. Written to devnet. */
export interface PlayerMoveEvent extends BaseEvent {
  type: "player_move";
  corridor: Corridor;
  action: Action;
}

/** How a player move turned out. Music resolves on "good", stays unresolved on "poor". */
export interface PlayerOutcomeEvent extends BaseEvent {
  type: "player_outcome";
  moveId: string;  // id of the player_move event this judges
  result: Outcome;
  reason: string;  // short plain-English reason
}

/** A corridor moves to a new state. Triggers the map pulse and music shift. */
export interface EscalationEvent extends BaseEvent {
  type: "escalation";
  corridor: Corridor;
  from: StormState;
  to: StormState;
}

/** "Reset storm" was pressed. Map, music and feed clear; next run's t starts at 0. */
export interface ResetEvent extends BaseEvent {
  type: "reset";
}

/** A batched devnet transaction confirmed. Links back to the events it logged. */
export interface TxConfirmedEvent extends BaseEvent {
  type: "tx_confirmed";
  signature: string;  // base58 Solana signature (Explorer link, devnet cluster)
  eventIds: string[]; // ids of the agent_decision / player_move events in this tx
  confirmMs: number;  // our measured time from send to "confirmed" commitment
}

/** A batched devnet transaction failed. Shown honestly in the UI. */
export interface TxFailedEvent extends BaseEvent {
  type: "tx_failed";
  eventIds: string[]; // ids of the events that were NOT logged
  error: string;      // short, human-readable error
}

export type VolatoneEvent =
  | TickEvent
  | AgentDecisionEvent
  | PlayerMoveEvent
  | PlayerOutcomeEvent
  | EscalationEvent
  | ResetEvent
  | TxConfirmedEvent
  | TxFailedEvent;

export type EventType = VolatoneEvent["type"];
