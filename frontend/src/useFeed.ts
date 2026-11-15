import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { VolatoneEvent } from "@volatone/shared";
import type { ReportMessage } from "@volatone/shared/protocol";
import { initialState, reduce } from "./state";
import { reportFromState } from "./report";
import { connectWs, type ConnStatus, type Transport } from "./transport";
import { connectMock } from "./mock";
import type { ClientMessage } from "./clientMessage";

const params = new URLSearchParams(window.location.search);
export const MOCK = params.has("mock");
const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";

export function useFeed() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [conn, setConn] = useState<ConnStatus>("connecting");
  const [serverReport, setServerReport] = useState<ReportMessage | null>(null);
  const transport = useRef<Transport>();

  useEffect(() => {
    const handlers = {
      onEvent: (event: VolatoneEvent) =>
        dispatch({ kind: "event", event }),
      onReport: (r: ReportMessage) => setServerReport(r),
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

  // After-action report. A new run clears it. The server pushes one a few seconds after the replay
  // finishes; if none has arrived 2 s after we see the end (for example a late join), ask for it.
  const finished = state.status === "finished";
  useEffect(() => {
    if (!finished) setServerReport(null);
  }, [finished]);
  useEffect(() => {
    if (MOCK || !finished || serverReport || conn !== "open") return;
    const timer = setTimeout(() => send({ type: "get_report" }), 2000);
    return () => clearTimeout(timer);
  }, [finished, serverReport, conn, send]);

  // Mock mode builds a local report (labelled as such); otherwise it comes from the server (Tiger Data).
  const report = finished ? (MOCK ? reportFromState(state) : serverReport) : null;
  return { state, conn, send, report };
}
