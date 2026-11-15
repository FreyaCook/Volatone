import { describe, expect, it } from "vitest";
import type { VolatoneEvent } from "@volatone/shared";
import { clipsForChange, freshFlags, introFor, shouldPlay } from "./narration";
import { initialState, reduce, type State } from "./state";

let n = 0;
type Ev = VolatoneEvent extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;
const fold = (events: Ev[], from: State = initialState()) =>
  events.reduce((s, e) => reduce(s, { kind: "event", event: { id: `e${++n}`, ...e } as VolatoneEvent }), from);
const tick = (t: number, corridor: "USD-JPY" | "EUR-JPY", state: "calm" | "spreading" | "storm") =>
  ({ t, type: "tick", corridor, state, risk: 0.5 }) as const;

describe("clipsForChange", () => {
  it("plays 'start' when a run begins, and resets the first-time flags", () => {
    const next = fold([tick(0, "USD-JPY", "calm")]);
    const r = clipsForChange(initialState(), next, { spreading: true, storm: true, easing: true }, 1);
    expect(r.clips).toEqual(["start"]);
    expect(r.flags).toEqual(freshFlags());
  });

  it("plays 'start' again after a restart (t goes back)", () => {
    const late = fold([tick(40_000, "USD-JPY", "storm")]);
    expect(clipsForChange(late, fold([tick(0, "USD-JPY", "calm")], initialState()), freshFlags(), 1).clips).toContain("start");
  });

  it("says 'spreading' only the first time any corridor goes calm to spreading in a run", () => {
    const a = fold([tick(1000, "USD-JPY", "calm")]);
    const b = fold([tick(2000, "USD-JPY", "spreading")], a);
    const first = clipsForChange(a, b, freshFlags(), 1);
    expect(first.clips).toEqual(["spreading"]);
    const c = fold([tick(3000, "USD-JPY", "calm"), tick(4000, "EUR-JPY", "calm")], b);
    const d = fold([tick(5000, "EUR-JPY", "spreading")], c);
    expect(clipsForChange(c, d, first.flags, 1).clips).toEqual([]);
  });

  it("says 'storm' once, and 'easing' once, when a corridor leaves storm", () => {
    const a = fold([tick(1000, "USD-JPY", "spreading")]);
    const b = fold([tick(2000, "USD-JPY", "storm")], a);
    const s = clipsForChange(a, b, freshFlags(), 1);
    expect(s.clips).toEqual(["storm"]);
    const c = fold([tick(3000, "USD-JPY", "spreading")], b);
    const e = clipsForChange(b, c, s.flags, 1);
    expect(e.clips).toEqual(["easing"]);
    const d = fold([tick(4000, "USD-JPY", "storm"), tick(5000, "USD-JPY", "spreading")], c);
    expect(clipsForChange(c, d, e.flags, 1).clips).toEqual([]);
  });

  it("plays 'prompt' when a prompt opens (last in the list) and 'good' or 'poor' when an outcome arrives", () => {
    const a = fold([tick(24_000, "USD-JPY", "storm")]);
    const b = fold([tick(25_000, "USD-JPY", "storm")], a);
    expect(clipsForChange(a, b, { spreading: true, storm: true, easing: true }, 1).clips).toEqual(["prompt"]);
    const mv = fold([{ t: 26_000, type: "player_move", corridor: "USD-JPY", action: "hedge" }], b);
    const moveId = mv.moves[0].id;
    const out = fold([{ t: 40_000, type: "player_outcome", moveId, result: "poor", reason: "r" }], mv);
    expect(clipsForChange(mv, out, freshFlags(), 1).clips).toEqual(["poor"]);
  });

  it("plays 'end' when the replay finishes", () => {
    const a = fold([tick(149_000, "USD-JPY", "calm")]);
    const b = fold([tick(150_000, "USD-JPY", "calm")], a);
    expect(clipsForChange(a, b, freshFlags(), 1).clips).toEqual(["end"]);
  });

  it("at speed 2 and 3 only prompt, good, poor and end are played", () => {
    const a = fold([tick(24_000, "USD-JPY", "spreading")]);
    const b = fold([tick(25_000, "USD-JPY", "storm")], a);
    expect(clipsForChange(a, b, freshFlags(), 3).clips).toEqual(["prompt"]);
    expect(clipsForChange(a, b, freshFlags(), 2).flags.storm).toBe(true);
  });
});

describe("overlap and intro rules", () => {
  it("drops a new clip while one plays, except prompt", () => {
    expect(shouldPlay("storm", true)).toBe(false);
    expect(shouldPlay("good", true)).toBe(false);
    expect(shouldPlay("prompt", true)).toBe(true);
    expect(shouldPlay("storm", false)).toBe(true);
  });

  it("intro only on the first START of a page session, and only at Normal speed", () => {
    expect(introFor(false, 1)).toBe(true);
    expect(introFor(true, 1)).toBe(false);
    expect(introFor(false, 2)).toBe(false);
  });
});
