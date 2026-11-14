import type { VolatoneEvent } from "@volatone/shared";
import type { ClientMessage } from "./clientMessage";

export type ConnStatus = "connecting" | "open" | "closed";
export interface Handlers {
  onEvent: (e: VolatoneEvent) => void;
  onStatus: (s: ConnStatus) => void; // "open" means history is about to be replayed: clear state first
}
export interface Transport {
  send: (m: ClientMessage) => void;
  close: () => void;
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
      try {
        h.onEvent(JSON.parse(String(m.data)) as VolatoneEvent);
      } catch {
        /* ignore a message that is not valid JSON */
      }
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
