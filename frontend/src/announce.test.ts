import { describe, expect, it } from "vitest";
import type { VolatoneEvent } from "@volatone/shared";
import { announce } from "./announce";
import { initialState, reduce, type State } from "./state";

let n = 0;
const id = () => `evt_${++n}`;
const fold = (events: VolatoneEvent[], from: State = initialState()) =>
  events.reduce((s, event) => reduce(s, { kind: "event", event }), from);

describe("announce", () => {
  it("announces a new agent decision with its explanation", () => {
    const prev = fold([{ id: id(), t: 1000, type: "tick", corridor: "USD-JPY", risk: 0.3, state: "calm" }]);
    const next = fold([{ id: id(), t: 1000, type: "agent_decision", agent: "sentinel", corridor: "USD-JPY", risk: 0.55, action: "hedge", explanation: "Sentinel: USD-JPY is jumpy." }], prev);
    expect(announce(prev, next)).toEqual(["Sentinel says hedge on USD-JPY, risk 55 percent. Sentinel: USD-JPY is jumpy."]);
  });

  it("announces state changes and prompt openings", () => {
    const prev = fold([{ id: id(), t: 24_000, type: "tick", corridor: "USD-JPY", risk: 0.5, state: "spreading" }]);
    const next = fold([{ id: id(), t: 25_000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" }], prev);
    const msgs = announce(prev, next);
    expect(msgs[0]).toBe("USD-JPY is now storm, risk 80 percent.");
    expect(msgs[1]).toContain("Your move on USD-JPY");
  });

  it("announces a closed, unanswered prompt as missed", () => {
    const prev = fold([{ id: id(), t: 32_000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" }]);
    const next = fold([{ id: id(), t: 33_000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" }], prev);
    expect(announce(prev, next)[0]).toContain("nothing was logged");
  });

  it("says nothing across a reset or reconnect", () => {
    const prev = fold([{ id: id(), t: 40_000, type: "tick", corridor: "USD-JPY", risk: 0.8, state: "storm" }]);
    expect(announce(prev, initialState())).toEqual([]);
  });
});
