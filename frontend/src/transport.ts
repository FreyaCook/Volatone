import type { VolatoneEvent } from "@volatone/shared";
import type { ReportMessage } from "@volatone/shared/protocol";
import type { ClientMessage } from "./clientMessage";

export type ConnStatus = "connecting" | "open" | "closed";
export interface Handlers {
  onEvent: (e: VolatoneEvent) => void;
  onReport?: (r: ReportMessage) => void; // the after-action report (not an event)
  onStatus: (s: ConnStatus) => void; // "open" means history is about to be replayed: clear state first
}
export interface Transport {
  send: (m: ClientMessage) => void;
  close: () => void;
}

/** A server message is either the after-action report or an event. Anything else is ignored. */
export function parseServerMessage(raw: string): { report: ReportMessage } | { event: VolatoneEvent } | null {
  try {
    const m = JSON.parse(raw) as { type?: unknown };
    if (typeof m !== "object" || m === null || typeof m.type !== "string") return null;
    return m.type === "report" ? { report: m as ReportMessage } : { event: m as VolatoneEvent };
  } catch {
    return null;
  }
}

/** WebSocket to the backend, with auto-reconnect (backoff up to 5 s). */
export function connectWs(url: string, h: Handlers): Transport {
  let ws: WebSocket | undefined;
  let stopped = false;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    h.onStatus("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 500;
      h.onStatus("open");
    };
    ws.onmessage = (m) => {
      const msg = parseServerMessage(String(m.data));
      if (!msg) return; // not valid JSON: ignore
      if ("report" in msg) h.onReport?.(msg.report);
      else h.onEvent(msg.event);
    };
    ws.onclose = () => {
      if (stopped) return;
      h.onStatus("closed");
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return {
    send: (m) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    close: () => {
      stopped = true;
      clearTimeout(timer);
      if (ws) ws.onclose = null;
      ws?.close();
    },
  };
}
