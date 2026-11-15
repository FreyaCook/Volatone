// Which narration clip to play, decided only from what changed in the feed (never from timers).
import { CORRIDORS, openPrompt, type State } from "./state";
import type { Speed } from "./clientMessage";

export type ClipId = "intro" | "start" | "spreading" | "storm" | "prompt" | "good" | "poor" | "easing" | "end";

/** "First time in this run" markers. */
export interface Flags { spreading: boolean; storm: boolean; easing: boolean }
export const freshFlags = (): Flags => ({ spreading: false, storm: false, easing: false });

/** At speed 2 and 3 there is no time for story clips: only these are played. */
const FAST_CLIPS: readonly ClipId[] = ["prompt", "good", "poor", "end"];

export function clipsForChange(prev: State, next: State, flags: Flags, speed: Speed): { clips: ClipId[]; flags: Flags } {
  let f = flags;
  const clips: ClipId[] = [];

  // A new run: the first replay after the page loads, or a restart (t goes back).
  const newRun = (prev.status === "idle" && next.status === "running") || next.t < prev.t;
  if (newRun) {
    f = freshFlags();
    clips.push("start");
  }

  const changes = CORRIDORS.map((c) => [prev.corridors[c].state, next.corridors[c].state] as const);
  if (!f.spreading && changes.some(([a, b]) => a === "calm" && b === "spreading")) {
    f = { ...f, spreading: true };
    clips.push("spreading");
  }
  if (!f.storm && changes.some(([a, b]) => a !== "storm" && b === "storm")) {
    f = { ...f, storm: true };
    clips.push("storm");
  }
  if (!f.easing && changes.some(([a, b]) => a === "storm" && b !== "storm")) {
    f = { ...f, easing: true };
    clips.push("easing");
  }

  for (const [id, o] of Object.entries(next.outcomes)) if (!prev.outcomes[id]) clips.push(o.result);
  if (prev.status !== "finished" && next.status === "finished") clips.push("end");

  // Last, so that it wins: the player's prompt interrupts whatever is playing.
  const opened = openPrompt(next);
  if (opened && opened.id !== openPrompt(prev)?.id) clips.push("prompt");

  return { clips: speed === 1 ? clips : clips.filter((c) => FAST_CLIPS.includes(c)), flags: f };
}

/** Pressing START: the intro (then "start") the first time in a page session, at Normal speed only. */
export const introFor = (alreadyPlayed: boolean, speed: Speed): boolean => !alreadyPlayed && speed === 1;

/** Overlap rule: a new clip is dropped while another plays, except "prompt", which interrupts. */
export const shouldPlay = (id: ClipId, somethingPlaying: boolean): boolean => !somethingPlaying || id === "prompt";
