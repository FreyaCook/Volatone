import type { ClientMessage as SharedClientMessage } from "@volatone/shared/protocol";

// TODO: remove this shim after merging the engine branch. shared/protocol.ts will then
// carry the optional `speed` field on start/reset, and we can import ClientMessage directly.
export type Speed = 1 | 2 | 3;

export type ClientMessage =
  | { type: "start"; speed?: Speed }
  | Extract<SharedClientMessage, { type: "player_move" }>
  | { type: "reset"; speed?: Speed };
