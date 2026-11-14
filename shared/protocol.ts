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

import type { Action, Corridor, ResetEvent } from "./events";

/** Run speed: 1 = Normal, 2 = Fast, 3 = Rush. Replay seconds per real second. */
export type Speed = NonNullable<ResetEvent["speed"]>;
export const SPEEDS: readonly Speed[] = [1, 2, 3];

export type ClientMessage =
  // idle: begin the replay at `speed` (default 1). Running: ignored. Finished: same as reset with `speed` (default 1).
  | { type: "start"; speed?: Speed }
  | { type: "player_move"; corridor: Corridor; action: Action } // answers the open prompt
  // "Reset storm": emits reset, restarts from t = 0. Keeps the current speed unless one is given.
  | { type: "reset"; speed?: Speed };

export type ClientMessageType = ClientMessage["type"];

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
