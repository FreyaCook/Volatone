// Plain-words announcements for the aria-live region: what changed between two states.
import { CORRIDORS, promptViews, type State } from "./state";

const word = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function announce(prev: State, next: State): string[] {
  // A reset or a reconnect rebuilds state from nothing: say nothing about the replayed history.
  if (next.t < prev.t || next.decisions.length < prev.decisions.length) return [];
  const out: string[] = [];

  const newDecisions = next.decisions.slice(0, next.decisions.length - prev.decisions.length).reverse();
  for (const d of newDecisions) {
    out.push(`${word(d.agent)} says ${d.action} on ${d.corridor}, risk ${Math.round(d.risk * 100)} percent. ${d.explanation}`);
  }

  for (const c of CORRIDORS) {
    if (prev.corridors[c].state !== next.corridors[c].state) {
      out.push(`${c} is now ${next.corridors[c].state}, risk ${Math.round(next.corridors[c].risk * 100)} percent.`);
    }
  }

  const before = promptViews(prev);
  promptViews(next).forEach((p, i) => {
    if (before[i].status !== "open" && p.status === "open") {
      out.push(`Your move on ${p.corridor}. Hedge, hold or reduce? Keys 1, 2 and 3. You have 8 seconds.`);
    }
    if (before[i].status !== "missed" && p.status === "missed") {
      out.push(`Prompt for ${p.corridor} closed. No move was made, so nothing was logged.`);
    }
  });

  for (const [moveId, o] of Object.entries(next.outcomes)) {
    if (!prev.outcomes[moveId]) out.push(`Outcome of your move: ${o.result}. ${o.reason}`);
  }
  return out;
}
