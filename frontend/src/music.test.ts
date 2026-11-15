import { describe, expect, it } from "vitest";
import type { VolatoneEvent } from "@volatone/shared";
import {
  DUCK_DOWN_S, DUCK_LEVEL, DUCK_UP_S, duckEnvelope, freshMusicSeen, maxStress, musicEvents, PROGRESSION, RESOLVE, tensionParams,
} from "./music";
import { initialState, reduce, type State } from "./state";

let n = 0;
const fold = (events: Omit<VolatoneEvent, "id">[], from: State = initialState()) =>
  events.reduce((s, e) => reduce(s, { kind: "event", event: { id: `m${++n}`, ...e } as VolatoneEvent }), from);
const tick = (t: number, corridor: "USD-JPY" | "EUR-JPY", state: "calm" | "spreading" | "storm", risk = 0.5) =>
  ({ t, type: "tick", corridor, state, risk }) as const;

describe("tensionParams", () => {
  it("calm (0): slow, silent pulse, open filter, no dissonance", () => {
    const p = tensionParams(0);
    expect(p).toEqual({ pulseBpm: 50, pulseGain: 0, filterHz: 1800, dissonanceGain: 0, busGain: 0.55 });
  });

  it("full tension (1): 110 bpm, full pulse, closed filter, dissonant note in, louder bus", () => {
    const p = tensionParams(1);
    expect(p.pulseBpm).toBeCloseTo(110);
    expect(p.pulseGain).toBeCloseTo(0.5);
    expect(p.filterHz).toBeCloseTo(450);
    expect(p.dissonanceGain).toBeCloseTo(0.12);
    expect(p.busGain).toBeCloseTo(0.8);
  });

  it("clamps out-of-range and non-numeric input", () => {
    expect(tensionParams(-5)).toEqual(tensionParams(0));
    expect(tensionParams(7)).toEqual(tensionParams(1));
    expect(tensionParams(NaN)).toEqual(tensionParams(0));
    expect(tensionParams(Infinity)).toEqual(tensionParams(0));
  });

  it("pulse fades in between 0.15 and 0.6; the dissonant note arrives after 0.4", () => {
    expect(tensionParams(0.15).pulseGain).toBe(0);
    expect(tensionParams(0.375).pulseGain).toBeCloseTo(0.25);
    expect(tensionParams(0.6).pulseGain).toBeCloseTo(0.5);
    expect(tensionParams(0.4).dissonanceGain).toBe(0);
    expect(tensionParams(0.7).dissonanceGain).toBeGreaterThan(0);
  });

  it("is monotonic: bpm, pulse, dissonance and bus rise, the filter closes", () => {
    const ps = [0, 0.2, 0.4, 0.6, 0.8, 1].map(tensionParams);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i].pulseBpm).toBeGreaterThan(ps[i - 1].pulseBpm);
      expect(ps[i].pulseGain).toBeGreaterThanOrEqual(ps[i - 1].pulseGain);
      expect(ps[i].dissonanceGain).toBeGreaterThanOrEqual(ps[i - 1].dissonanceGain);
      expect(ps[i].busGain).toBeGreaterThan(ps[i - 1].busGain);
      expect(ps[i].filterHz).toBeLessThan(ps[i - 1].filterHz);
    }
  });
});

describe("ducking envelope", () => {
  it("ducks to 35% over 150 ms and returns to 100% over 600 ms", () => {
    expect(duckEnvelope(true)).toEqual({ target: 0.35, seconds: 0.15 });
    expect(duckEnvelope(false)).toEqual({ target: 1, seconds: 0.6 });
    expect([DUCK_LEVEL, DUCK_DOWN_S, DUCK_UP_S]).toEqual([0.35, 0.15, 0.6]);
  });
});

describe("maxStress and musicEvents", () => {
  it("stress is the highest corridor risk, 0 with no ticks", () => {
    expect(maxStress(initialState())).toBe(0);
    expect(maxStress(fold([tick(1000, "USD-JPY", "calm", 0.3), tick(1000, "EUR-JPY", "storm", 0.9)]))).toBe(0.9);
  });

  it("storm hit fires once per run, the first time any corridor reaches storm", () => {
    const a = fold([tick(1000, "USD-JPY", "spreading")]);
    const b = fold([tick(2000, "USD-JPY", "storm")], a);
    const first = musicEvents(a, b, freshMusicSeen());
    expect(first.stormHit).toBe(true);
    const c = fold([tick(3000, "EUR-JPY", "storm")], b);
    expect(musicEvents(b, c, first.seen).stormHit).toBe(false);
  });

  it("a restart makes the next storm count again and flags a new run", () => {
    const late = fold([tick(40_000, "USD-JPY", "storm")]);
    const restart = fold([tick(0, "USD-JPY", "calm")], initialState());
    const r = musicEvents(late, restart, { storm: true });
    expect(r.newRun).toBe(true);
    expect(r.seen.storm).toBe(false);
  });

  it("signals the end when the replay finishes", () => {
    const a = fold([tick(149_000, "USD-JPY", "calm")]);
    const b = fold([tick(150_000, "USD-JPY", "calm")], a);
    expect(musicEvents(a, b, freshMusicSeen()).ended).toBe(true);
  });
});

describe("chords", () => {
  it("every chord has four voices, and the resolution is a major-ish chord", () => {
    for (const c of PROGRESSION) expect(c).toHaveLength(4);
    expect(RESOLVE).toHaveLength(4);
    expect((RESOLVE[1] - RESOLVE[0]) % 12).toBe(4); // major third above the root
  });
});
