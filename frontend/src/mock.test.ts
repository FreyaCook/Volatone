import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VolatoneEvent } from "@volatone/shared";
import { connectMock } from "./mock";
import { initialState, promptViews, reduce } from "./state";

describe("mock stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a full run the reducer can fold, with a player move and its outcome", () => {
    const events: VolatoneEvent[] = [];
    const m = connectMock({ onEvent: (e) => events.push(e), onStatus: () => {} }, 1000);
    m.send({ type: "start", speed: 3 });
    vi.advanceTimersByTime(27_000 / 3); // into the first prompt (second 26)
    m.send({ type: "player_move", corridor: "USD-JPY", action: "hedge" });
    vi.advanceTimersByTime(160_000);
    const state = events.reduce((s, event) => reduce(s, { kind: "event", event }), initialState());
    expect(state.status).toBe("finished");
    expect(state.moves).toHaveLength(1);
    expect(Object.keys(state.outcomes)).toHaveLength(1);
    expect(state.decisions.length).toBeGreaterThan(10);
    expect(state.txs.length).toBeGreaterThan(3);
    const statuses = promptViews(state).map((p) => p.status);
    expect(statuses).toEqual(["answered", "missed", "missed", "missed"]);
    m.close();
  });

  it("ids are unique", () => {
    const events: VolatoneEvent[] = [];
    const m = connectMock({ onEvent: (e) => events.push(e), onStatus: () => {} }, 1000);
    m.send({ type: "start", speed: 3 });
    vi.advanceTimersByTime(60_000);
    m.send({ type: "reset" });
    vi.advanceTimersByTime(10_000);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    m.close();
  });
});
