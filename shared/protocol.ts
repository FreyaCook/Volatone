// shared/protocol.ts
// The WebSocket protocol between the backend and the browser.
//
//  - Server -> client: every message is one VolatoneEvent as JSON (see events.ts). Nothing else.
//    A client that connects mid-run is first sent every event since the current run began
//    (starting with its "reset" event, if the run began with one), then live events.
//  - Client -> server: one ClientMessage as JSON (below). Invalid or ill-timed messages are ignored.
//
// Speed only changes how fast replay seconds pass in real time. All `t` values, prompt windows and
// the 15 s look-ahead are in replay time, so they are identical at every speed. Any other speed
// value makes the whole message invalid (ignored).
//
// There is no "prompt" event: a client knows a prompt is open from the tick times. A prompt for
// DECISION_POINTS[i] opens with the first tick at t = second * 1000 and accepts one player_move
// until the tick at t = (second + PROMPT_SECONDS) * 1000. No player_move in that window = "missed".

import type { Action, AgentName, Corridor, Outcome, ResetEvent } from "./events";

/** Run speed: 1 = Normal, 2 = Fast, 3 = Rush. Replay seconds per real second. */
export type Speed = NonNullable<ResetEvent["speed"]>;
export const SPEEDS: readonly Speed[] = [1, 2, 3];

export type ClientMessage =
  // idle: begin the replay at `speed` (default 1). Running: ignored. Finished: same as reset with `speed` (default 1).
  | { type: "start"; speed?: Speed }
  | { type: "player_move"; corridor: Corridor; action: Action } // answers the open prompt
  // "Reset storm": emits reset, restarts from t = 0. Keeps the current speed unless one is given.
  | { type: "reset"; speed?: Speed }
  // Ask for the after-action report of the current run. The server answers this client with one ReportMessage.
  | { type: "get_report" }
  // Ask for the list of recent completed runs. The server answers this client with one RunsMessage.
  | { type: "get_runs" };

export type ClientMessageType = ClientMessage["type"];

// ---- After-action report (additive) ----
// The one server -> client message that is not a VolatoneEvent. It is sent to every client a few
// seconds after the replay finishes, and to one client when it sends "get_report". It is built only
// from rows read back out of Tiger Data (TimescaleDB). Status "off": Tiger Data is switched off.
// "unavailable": it is on but could not be read. Only "ok" carries data. It never carries secrets.

export type ReportStatus = "ok" | "unavailable" | "off";

export interface ReportMove {
  corridor: Corridor;
  action: Action;
  replayT: number;
  /** null while the 15 s look-ahead has not ended yet */
  result: Outcome | null;
  reason: string | null;
  /** each agent's latest view of that corridor at the time of the move */
  views: { agent: AgentName; action: Action; risk: number }[];
}

export interface ReportMessage {
  type: "report";
  status: ReportStatus;
  runId?: string;
  /** how long the report queries took, in ms */
  queryMs?: number;
  /** which kind of aggregate answered the peak-risk query */
  aggregate?: "continuous" | "view";
  corridors?: { corridor: Corridor; peakRisk: number; meanRisk: number }[];
  agentViews?: number;
  moves?: ReportMove[];
  solana?: { count: number; minMs: number | null; meanMs: number | null; maxMs: number | null; failures: number };
}

// ---- Past runs (additive) ----
// One document per completed run is kept in MongoDB Atlas. The server sends the last 10, newest first,
// after each replay finishes and when a client sends "get_runs". Small fields only; never any secret.
// Status "off": MongoDB is switched off. "unavailable": it is on but could not be read.

export interface RunSummary {
  runId: string;
  finishedAt: string; // ISO date-time
  speed: number;
  goodCalls: number;  // player moves judged good ...
  moves: number;      // ... out of all player moves
  peakRisk: number;   // highest corridor peak, 0..1
  confirmedBatches: number; // confirmed Solana devnet batches
}

export interface RunsMessage {
  type: "runs";
  status: ReportStatus;
  runs?: RunSummary[];
}

/** The replay's decision points (fixed by backend/src/storm/storm.json; a backend test checks they match). */
export const DECISION_POINTS: readonly { id: string; second: number; corridor: Corridor }[] = [
  { id: "dp1", second: 25, corridor: "USD-JPY" },
  { id: "dp2", second: 72, corridor: "GBP-USD" },
  { id: "dp3", second: 95, corridor: "EUR-USD" },
  { id: "dp4", second: 132, corridor: "EUR-JPY" },
];

/** A prompt stays open this many replay seconds. */
export const PROMPT_SECONDS = 8;

/** The replay emits ticks for seconds 0..REPLAY_LAST_SECOND, one second apart, then finishes. */
export const REPLAY_LAST_SECOND = 150;
