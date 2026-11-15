// WebSocket feed for the replay engine.
//  - Server -> client: each VolatoneEvent as JSON. On connect, every event since the current run began.
//  - Client -> server: ClientMessage JSON (shared/protocol.ts). Anything invalid is ignored (logged here).

import { WebSocketServer, type WebSocket } from "ws";
import type { Action, Corridor } from "@volatone/shared";
import { SPEEDS, type ClientMessage, type ReportMessage, type RunsMessage, type Speed } from "@volatone/shared/protocol";
import { CORRIDORS } from "../storm/storm";
import type { ReplayEngine } from "./replay";

const ACTIONS: readonly Action[] = ["hedge", "hold", "reduce"];

/** Parses and validates one client message. null if it isn't a valid ClientMessage. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "start":
    case "reset": {
      if (o.speed === undefined) return { type: o.type };
      if (!SPEEDS.includes(o.speed as Speed)) return null; // any other speed: the message is invalid
      return { type: o.type, speed: o.speed as Speed };
    }
    case "get_report":
      return { type: "get_report" };
    case "get_runs":
      return { type: "get_runs" };
    case "player_move":
      if (!CORRIDORS.includes(o.corridor as Corridor) || !ACTIONS.includes(o.action as Action)) return null;
      return { type: "player_move", corridor: o.corridor as Corridor, action: o.action as Action };
    default:
      return null;
  }
}

export function attachServer(
  wss: WebSocketServer,
  engine: ReplayEngine,
  log: (msg: string) => void = () => {},
  /** Answers "get_report". Without it (or if it throws) the message is ignored. */
  onGetReport?: () => Promise<ReportMessage>,
  /** Answers "get_runs". Without it (or if it throws) the message is ignored. */
  onGetRuns?: () => Promise<RunsMessage>,
): () => void {
  const send = (ws: WebSocket, data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  const unsubscribe = engine.subscribe((e) => {
    const data = JSON.stringify(e);
    for (const ws of wss.clients) send(ws, data);
  });

  wss.on("connection", (ws) => {
    for (const e of engine.history()) send(ws, JSON.stringify(e)); // late joiner catch-up
    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return log(`ignored invalid client message: ${data.toString().slice(0, 100)}`);
      if (msg.type === "start") engine.start(msg.speed);
      else if (msg.type === "reset") engine.reset(msg.speed);
      else if (msg.type === "get_runs") {
        if (onGetRuns) void onGetRuns().then((r) => send(ws, JSON.stringify(r)), () => {});
      } else if (msg.type === "get_report") {
        if (onGetReport) void onGetReport().then((r) => send(ws, JSON.stringify(r)), () => {});
      } else engine.playerMove(msg.corridor, msg.action);
    });
  });

  return unsubscribe;
}
