import { useEffect, useRef } from "react";
import type { State } from "./state";
import type { ConnStatus } from "./transport";

/**
 * Calls `onChange(prev, next)` after each state change, except while history is being replayed after
 * a (re)connect: a late join rebuilds state from old events and must not announce or play them.
 */
export function useStateChanges(state: State, conn: ConnStatus, onChange: (prev: State, next: State) => void) {
  const prev = useRef(state);
  const quietUntil = useRef(0);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (conn === "open") quietUntil.current = Date.now() + 1500;
  }, [conn]);

  useEffect(() => {
    if (Date.now() >= quietUntil.current) cb.current(prev.current, state);
    prev.current = state;
  }, [state]);
}
