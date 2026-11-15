// Music and cues, generated in the browser with the Web Audio API. No audio files.
// A soft drone whose tension (detune, brightness, a third voice) rises with the number of corridors in storm.
// Layers: the drone (below), the generative music in music.ts, and short cues. The drone and the music
// both pass through one "duck" gain so narration can lower them together; the master gain is the mute.
// Sound is never the only cue: every cue has an on-screen and aria-live equivalent.

import { duckEnvelope, Music } from "./music";

/** 0..1 tension from the number of corridors in storm (0..4). */
export const tensionFor = (stormCorridors: number) => Math.min(1, Math.max(0, stormCorridors / 4));

type Cue = "decision" | "prompt" | "good" | "poor";

export class Sound {
  private ctx?: AudioContext;
  private master?: GainNode;
  private duck?: GainNode;
  private music?: Music;
  private filter?: BiquadFilterNode;
  private voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  muted = false;
  private tension = 0;

  /** Call from a user gesture (first click or key). Safe to call again. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    let ctx: AudioContext;
    try { ctx = new Ctx(); } catch { return; } // no usable audio: stay silent
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);
    this.duck = ctx.createGain();
    this.duck.connect(this.master);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.connect(this.duck);
    this.music = new Music(ctx, this.duck);
    // Root, fifth, and a slightly detuned root (slow beating). Pitches stay low and soft.
    for (const [freq, level] of [[110, 0.5], [165, 0.25], [110.5, 0.35]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = level * 0.08;
      osc.connect(gain).connect(this.filter);
      osc.start();
      this.voices.push({ osc, gain });
    }
    this.setTension(this.tension);
  }

  /** Music follows the highest corridor risk (0..1). */
  setStress(x: number) { this.music?.setStress(x); }
  stormHit() { this.music?.stormHit(); }
  endMusic() { this.music?.end(); }
  resetMusic() { this.music?.reset(); }

  /** Narration playing: music and drone go down to 35% in 150 ms, and come back over 600 ms. */
  setDucked(ducked: boolean) {
    if (!this.ctx || !this.duck) return;
    const { target, seconds } = duckEnvelope(ducked);
    this.duck.gain.setTargetAtTime(target, this.ctx.currentTime, seconds / 3);
  }

  /** Stop everything and release the audio context (unmount). A later start() builds it again. */
  dispose() {
    try {
      this.music?.dispose();
      this.voices.forEach((v) => { try { v.osc.stop(); } catch { /* already stopped */ } });
      void this.ctx?.close();
    } catch { /* ignore */ }
    this.ctx = this.master = this.duck = this.filter = undefined;
    this.music = undefined;
    this.voices = [];
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  setTension(t: number) {
    this.tension = t;
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(280 + 900 * t, now, 0.8);
    this.voices[2].osc.detune.setTargetAtTime(t * 35, now, 0.8); // beating, never harsh
    this.voices[1].gain.gain.setTargetAtTime((0.25 + 0.5 * t) * 0.08, now, 0.8);
    this.voices[0].osc.frequency.setTargetAtTime(110 - 6 * t, now, 1.5);
  }

  cue(kind: Cue) {
    if (!this.ctx || !this.master || this.muted) return;
    const notes: Record<Cue, [number, number][]> = {
      decision: [[660, 0]], // one soft bell
      prompt: [[523, 0], [784, 0.14]], // two rising notes
      good: [[523, 0], [659, 0.12], [784, 0.24]], // resolves upward
      poor: [[392, 0], [311, 0.18]], // stays unresolved
    };
    for (const [freq, delay] of notes[kind]) this.blip(freq, delay, kind === "decision" ? 0.05 : 0.09);
  }

  private blip(freq: number, delay: number, level: number) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    osc.connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + 0.6);
  }
}
