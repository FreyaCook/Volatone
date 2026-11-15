// Plays the pre-generated ElevenLabs clips from /narration/. Never throws: a missing manifest or clip
// just means silence. Callers decide WHEN to play (see narration.ts); this only plays one at a time.
import { shouldPlay, type ClipId } from "./narration";

interface Entry { id: ClipId; text: string; file: string }
const BASE = `${import.meta.env.BASE_URL}narration/`;
const CAPTION_ONLY_MS = 3500; // how long a caption stays when muted (nothing to wait for)

export class Narrator {
  private clips = new Map<ClipId, Entry>();
  private audio?: HTMLAudioElement;
  private timer?: ReturnType<typeof setTimeout>;
  private current?: ClipId;
  private muted = false;
  /** Called with the spoken line while a clip plays, and with null when it ends. */
  onCaption: (c: { id: ClipId; text: string } | null) => void = () => {};

  async load() {
    try {
      const res = await fetch(`${BASE}narration.json`);
      if (!res.ok) return;
      const list = (await res.json()) as Entry[];
      this.clips = new Map(list.map((e) => [e.id, e]));
    } catch {
      /* no narration available: stay silent */
    }
  }

  get available() { return this.clips.size > 0; }

  setMuted(m: boolean) {
    this.muted = m;
    if (m && this.audio) this.stop(); // respect mute immediately
  }

  /** `then`: a clip to play when this one ends (used for intro -> start). */
  play(id: ClipId, then?: ClipId) {
    try {
      const entry = this.clips.get(id);
      if (!entry || !shouldPlay(id, this.current !== undefined)) return;
      if (this.current) this.stop(); // only "prompt" gets here while something plays
      this.current = id;
      this.onCaption({ id, text: entry.text });
      const done = () => {
        if (this.current !== id) return;
        this.current = undefined;
        this.onCaption(null);
        if (then) this.play(then);
      };
      if (this.muted) {
        this.timer = setTimeout(done, CAPTION_ONLY_MS);
        return;
      }
      const a = (this.audio = new Audio(`${BASE}${entry.file}`));
      a.onended = done;
      a.onerror = done; // clip failed to load: ignore silently
      a.play().catch(done); // e.g. blocked before the first click
    } catch {
      this.current = undefined;
    }
  }

  private stop() {
    clearTimeout(this.timer);
    if (this.audio) {
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause();
      this.audio = undefined;
    }
    this.current = undefined;
    this.onCaption(null);
  }
}
