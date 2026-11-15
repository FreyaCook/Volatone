// Generative music layer: pure Web Audio synthesis, no samples, no files, no network.
// The pure functions (tension -> parameters, ducking, which feed changes trigger music events) are
// unit-tested; the Music class only turns those numbers into sound.
import { CORRIDORS, type State } from "./state";

// ---------- Pure: tension -> parameters ----------

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
/** 0 below `from`, 1 above `to`, linear in between. */
const ramp = (x: number, from: number, to: number) => clamp01((x - from) / (to - from));

export interface MusicParams {
  pulseBpm: number;       // low pulse rate
  pulseGain: number;      // low pulse level (0 = silent)
  filterHz: number;       // pad low-pass cutoff
  dissonanceGain: number; // level of the one dissonant note (tritone)
  busGain: number;        // music bus level
}

/**
 * Tension 0..1 (out-of-range and NaN are clamped / treated as 0):
 *  - pulse: silent below 0.15, fades in to full by 0.6; rate rises linearly 50 -> 110 bpm
 *  - pad filter: closes exponentially from 1800 Hz (calm) to 450 Hz (full tension)
 *  - dissonant note: silent below 0.4, fades in to 0.12 at full tension
 *  - bus: 0.55 (calm) -> 0.80 (full tension), so the music also gets a little louder
 */
export function tensionParams(tension: number): MusicParams {
  const x = clamp01(tension);
  return {
    pulseBpm: lerp(50, 110, x),
    pulseGain: 0.5 * ramp(x, 0.15, 0.6),
    filterHz: 1800 * Math.pow(450 / 1800, x),
    dissonanceGain: 0.12 * ramp(x, 0.4, 1),
    busGain: lerp(0.55, 0.8, x),
  };
}

/** Tension is the highest risk among the four corridors (the same 0..1 risk drawn on the chart). */
export const maxStress = (s: State): number => Math.max(0, ...CORRIDORS.map((c) => s.corridors[c].risk));

// ---------- Pure: ducking under narration ----------

export const DUCK_LEVEL = 0.35;
export const DUCK_DOWN_S = 0.15;
export const DUCK_UP_S = 0.6;

/** Target level and ramp time for the duck gain: down to 35% in 150 ms, back to 100% over 600 ms. */
export const duckEnvelope = (ducked: boolean) =>
  ducked ? { target: DUCK_LEVEL, seconds: DUCK_DOWN_S } : { target: 1, seconds: DUCK_UP_S };

// ---------- Pure: which feed changes trigger music events ----------

export interface MusicSeen { storm: boolean }
export const freshMusicSeen = (): MusicSeen => ({ storm: false });

export function musicEvents(prev: State, next: State, seen: MusicSeen) {
  const newRun = (prev.status === "idle" && next.status === "running") || next.t < prev.t;
  const base = newRun ? freshMusicSeen() : seen;
  const wentStorm = CORRIDORS.some((c) => prev.corridors[c].state !== "storm" && next.corridors[c].state === "storm");
  const stormHit = !base.storm && wentStorm;
  return {
    newRun,
    stormHit,
    ended: prev.status !== "finished" && next.status === "finished",
    seen: stormHit ? { storm: true } : base,
  };
}

// ---------- Chords (A minor family; the drone in sound.ts sits on A) ----------

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Calm progression: Am7 - Fmaj7 - Cmaj7 - G6, four voices each. */
export const PROGRESSION: readonly (readonly number[])[] = [
  [57, 60, 64, 67], [53, 57, 60, 64], [60, 64, 67, 71], [55, 59, 62, 64],
];
/** Warmer, major-ish resolution at the end of the replay: A major add9. */
export const RESOLVE: readonly number[] = [57, 61, 64, 71];
const TRITONE_MIDI = 63; // E-flat above the A: a tritone against the A root

export const CHORD_EVERY_S = [8, 12] as const; // real seconds, random in this range
const TICK_MS = 100;

// ---------- The synth ----------

export class Music {
  private nodes: AudioNode[] = [];
  private sources: (OscillatorNode | AudioBufferSourceNode)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private tick?: ReturnType<typeof setInterval>;
  private voices: OscillatorNode[] = [];
  private dissonance!: GainNode;
  private filter!: BiquadFilterNode;
  private bus!: GainNode;
  private fade!: GainNode;
  private pulseOut!: GainNode;
  private reverb!: ConvolverNode;
  private target = 0;
  private current = 0;
  private chord = 0;
  private resolved = false;
  private nextBeat = 0;
  private lastTick = 0;
  private reduceMotion?: MediaQueryList;
  private disposed = false;

  /** `out` is where the music goes (the master/mute path, through the duck). Never throws. */
  constructor(private ctx: AudioContext, out: AudioNode) {
    try {
      this.reduceMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
      const c = ctx;
      this.fade = this.node(c.createGain());
      this.bus = this.node(c.createGain());
      this.bus.gain.value = tensionParams(0).busGain;
      this.bus.connect(this.fade).connect(out);

      // Pad: four detuned oscillators -> low-pass -> pad gain (slow fade-in) -> bus
      this.filter = this.node(c.createBiquadFilter());
      this.filter.type = "lowpass";
      this.filter.frequency.value = tensionParams(0).filterHz;
      const padGain = this.node(c.createGain());
      padGain.gain.value = 0;
      padGain.gain.setTargetAtTime(0.09, c.currentTime, 3); // slow attack
      this.filter.connect(padGain).connect(this.bus);
      PROGRESSION[0].forEach((m, i) => {
        const osc = this.source(c.createOscillator());
        osc.type = i % 2 ? "triangle" : "sine";
        osc.frequency.value = midiHz(m);
        osc.detune.value = [-7, 4, -3, 6][i];
        osc.connect(this.filter);
        osc.start();
        this.voices.push(osc);
      });

      // The one dissonant note, silent until tension rises
      const d = this.source(c.createOscillator());
      d.type = "triangle";
      d.frequency.value = midiHz(TRITONE_MIDI);
      this.dissonance = this.node(c.createGain());
      this.dissonance.gain.value = 0;
      d.connect(this.dissonance).connect(this.filter);
      d.start();

      // Low pulse and storm hit share a reverb-like tail: a convolver fed with generated, decaying noise
      this.pulseOut = this.node(c.createGain());
      this.pulseOut.connect(this.bus);
      this.reverb = this.node(c.createConvolver());
      this.reverb.buffer = this.impulse(2.2);
      const wet = this.node(c.createGain());
      wet.gain.value = 0.5;
      this.reverb.connect(wet).connect(this.bus);

      this.nextBeat = c.currentTime + 0.5;
      this.lastTick = c.currentTime;
      this.tick = setInterval(() => this.step(), TICK_MS);
      this.scheduleChord();
    } catch {
      this.dispose(); // no usable audio: stay silent
    }
  }

  setStress(x: number) { this.target = clamp01(x); }

  /** One deep low hit with a short reverb tail, the first time any corridor reaches storm. */
  stormHit() {
    if (this.disposed) return;
    try {
      const c = this.ctx, t = c.currentTime;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(58, t);
      osc.frequency.exponentialRampToValueAtTime(32, t + 1.2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.7, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      osc.connect(g);
      g.connect(this.bus); // dry
      g.connect(this.reverb); // tail
      osc.start(t);
      osc.stop(t + 1.7);
    } catch { /* ignore */ }
  }

  /** Replay complete: resolve to a warm major chord, drain tension, fade out over about 4 s. */
  end() {
    if (this.disposed) return;
    this.resolved = true;
    this.target = 0;
    this.glideTo(RESOLVE);
    const t = this.ctx.currentTime;
    this.fade.gain.cancelScheduledValues(t);
    this.fade.gain.setValueAtTime(1, t);
    this.fade.gain.setTargetAtTime(0, t + 1.5, 4 / 3); // ~95% down about 4 s after it starts
  }

  /** Back to the start of the progression, calm, audible. */
  reset() {
    if (this.disposed) return;
    this.resolved = false;
    this.target = 0;
    this.current = 0;
    this.chord = 0;
    const t = this.ctx.currentTime;
    this.fade.gain.cancelScheduledValues(t);
    this.fade.gain.setTargetAtTime(1, t, 0.3);
    this.glideTo(PROGRESSION[0]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.tick);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
    this.sources = [];
    this.nodes = [];
  }

  // ----- internals -----

  private node<T extends AudioNode>(n: T): T { this.nodes.push(n); return n; }
  private source<T extends OscillatorNode>(s: T): T { this.sources.push(s); return this.node(s); }

  private impulse(seconds: number) {
    const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  private glideTo(chord: readonly number[]) {
    const t = this.ctx.currentTime;
    this.voices.forEach((v, i) => v.frequency.setTargetAtTime(midiHz(chord[i]), t, 1.5)); // slow glide, no clicks
  }

  private scheduleChord() {
    const [lo, hi] = CHORD_EVERY_S;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      if (!this.resolved) {
        this.chord = (this.chord + 1) % PROGRESSION.length;
        this.glideTo(PROGRESSION[this.chord]);
      }
      this.scheduleChord();
    }, (lo + Math.random() * (hi - lo)) * 1000); // real time, not replay time
    this.timers.add(timer);
  }

  /** Every 100 ms: smooth the tension, apply the parameters, schedule pulse beats just ahead. */
  private step() {
    try {
      const c = this.ctx, now = c.currentTime;
      const dt = Math.max(0, now - this.lastTick);
      this.lastTick = now;
      // Rises within about a second; drains slowly (about 4 s), so a storm easing is audible.
      const tc = this.target > this.current ? 1 : 4;
      this.current += (this.target - this.current) * (1 - Math.exp(-dt / tc));
      const p = tensionParams(this.current);
      this.filter.frequency.setTargetAtTime(p.filterHz, now, 0.2);
      this.dissonance.gain.setTargetAtTime(p.dissonanceGain, now, 0.5);
      this.bus.gain.setTargetAtTime(p.busGain, now, 0.3);

      const pulseOn = p.pulseGain > 0.01 && !this.reduceMotion?.matches && !this.resolved;
      if (this.nextBeat < now) this.nextBeat = now;
      while (this.nextBeat < now + 0.25) {
        if (pulseOn) this.kick(this.nextBeat, p.pulseGain);
        this.nextBeat += 60 / p.pulseBpm; // follows real time; capped at 110 bpm
      }
    } catch { /* never break the app */ }
  }

  private kick(t: number, level: number) {
    const c = this.ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * 0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(g).connect(this.pulseOut);
    osc.start(t);
    osc.stop(t + 0.4);
  }
}
