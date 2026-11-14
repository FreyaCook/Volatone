import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { VolatoneEvent } from "@volatone/shared";
import { initialState, reduce } from "./state";
import { connectWs, type ConnStatus, type Transport } from "./transport";
import { connectMock } from "./mock";
import type { ClientMessage } from "./clientMessage";

const params = new URLSearchParams(window.location.search);
export const MOCK = params.has("mock");
const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";

export function useFeed() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [conn, setConn] = useState<ConnStatus>("connecting");
  const transport = useRef<Transport>();

  useEffect(() => {
    const handlers = {
      onEvent: (event: VolatoneEvent) =>
        dispatch({ kind: "event", event }),
      onStatus: (s: ConnStatus) => {
        setConn(s);
        if (s === "open") dispatch({ kind: "clear" }); // history is replayed from the start
      },
    };
    const t = MOCK ? connectMock(handlers, Number(params.get("tick")) || 1000) : connectWs(WS_URL, handlers);
    transport.current = t;
    // Dev aid for screenshots: ?mock=1&autostart=1&speed=3 starts the mock replay by itself.
    if (MOCK && params.has("autostart")) t.send({ type: "start", speed: (Number(params.get("speed")) || 1) as 1 | 2 | 3 });
    return () => t.close();
  }, []);

  const send = useCallback((m: ClientMessage) => transport.current?.send(m), []);
  return { state, conn, send };
}
