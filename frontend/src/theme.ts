import type { StormState } from "@volatone/shared";

// Colour is never the only signal: every state also has a name, an icon and a line pattern.
export const STATE_LABEL: Record<StormState, string> = { calm: "Calm", spreading: "Spreading", storm: "Storm" };
export const STATE_ICON: Record<StormState, string> = { calm: "●", spreading: "▲", storm: "◆" };

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
