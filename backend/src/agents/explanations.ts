// Cached Gemini explanations (explanations.json, written by scripts/make-explanations.ts).
// Missing file, missing entries or entries that fail validation => the plain-English fallback
// in runner.ts is used for that decision.
//
// Key per planned decision: "<second>:<agent>:<corridor>" (explanationKey).
// This file also holds the pure parts of the generator (prompt + response parsing) so they are tested.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentName, Corridor } from "@volatone/shared";
import { fallbackExplanation, type PlannedDecision } from "./runner";
import { THRESHOLDS } from "./scoring";
import { AGENT_LABEL, MAX_EXPLANATION_CHARS, validateForDecision, type Validation } from "./validate";

export const EXPLANATIONS_PATH = fileURLToPath(new URL("./explanations.json", import.meta.url));

export interface ExplanationsFile {
  model: string;
  generatedAt: string; // ISO date
  explanations: Record<string, string>; // explanationKey() -> text (only texts that passed validation)
}

export const explanationKey = (d: Pick<PlannedDecision, "second" | "agent" | "corridor">): string =>
  `${d.second}:${d.agent}:${d.corridor}`;

/** "72:strategist:GBP-USD" -> its parts, or null. */
export function parseKey(key: string): { second: number; agent: AgentName; corridor: Corridor } | null {
  const m = /^(\d+):(sentinel|opportunist|strategist):(USD-JPY|EUR-JPY|EUR-USD|GBP-USD)$/.exec(key);
  return m ? { second: Number(m[1]), agent: m[2] as AgentName, corridor: m[3] as Corridor } : null;
}

/** Loads the cache, keeping only entries whose key is valid and whose text passes validateForDecision. */
export function loadExplanations(path = EXPLANATIONS_PATH): { texts: Map<string, string>; source: string } {
  if (!existsSync(path)) return { texts: new Map(), source: "explanations: none cached, using fallback text" };
  let file: ExplanationsFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as ExplanationsFile;
  } catch {
    return { texts: new Map(), source: "explanations: file unreadable, using fallback text" };
  }
  const texts = new Map<string, string>();
  let rejected = 0;
  for (const [key, text] of Object.entries(file.explanations ?? {})) {
    const d = parseKey(key);
    if (d && validateForDecision(text, d).ok) texts.set(key, text.trim());
    else rejected++;
  }
  const note = rejected ? `, ${rejected} rejected` : "";
  return { texts, source: `explanations: ${texts.size} cached${note} (${file.model}, ${file.generatedAt}); others use fallback text` };
}

// ---------- Generator (pure parts) ----------

/** What each agent's rule actually measures, so the text never claims more than the rule does. */
const RULES: Record<AgentName, string> = {
  sentinel:
    "Cautious. Scores the bigger of two numbers on its own corridor: how big the move over the last 5 seconds was, and how jumpy prices were over the last 10 seconds.",
  opportunist:
    "Contrarian. Scores jumpiness over the last 10 seconds, discounted by how much of the latest big move has already bounced back. A bounce means a chance, not a danger.",
  strategist:
    "Big picture. Re-scores every 10 seconds: half its own slow 30-second jumpiness, half how many of the other three corridors are in trouble.",
};

const thresholdText = (a: AgentName) =>
  `hedge at ${Math.round(THRESHOLDS[a].hedge * 100)}%+, reduce at ${Math.round(THRESHOLDS[a].reduce * 100)}%+, otherwise hold`;

export function buildPrompt(plan: PlannedDecision[]): string {
  const items = plan.map((d) => ({
    key: explanationKey(d),
    agent: AGENT_LABEL[d.agent],
    corridor: d.corridor,
    second: d.second,
    risk: `${Math.round(d.risk * 100)}%`,
    action: d.action,
    why: d.why === "decision_point" ? "asked by the player at a decision point" : "its view held steady for several scores",
    example: fallbackExplanation(d),
  }));
  return [
    "You write one-line explanations for Volatone, a market-storm SIMULATION with fake money. It is not financial advice.",
    "Three rule-based agents score currency corridors (risk 0-100%) and announce an action: hedge, hold or reduce.",
    "",
    "The agents' rules (explain only what the rule measures; never claim more):",
    ...(["sentinel", "opportunist", "strategist"] as AgentName[]).map(
      (a) => `- ${AGENT_LABEL[a]}: ${RULES[a]} Thresholds: ${thresholdText(a)}.`,
    ),
    "",
    "For EVERY decision below, write one explanation:",
    `- Exactly one sentence, plain English, under ${MAX_EXPLANATION_CHARS} characters, in the agent's own voice.`,
    '- Start with the agent name and a colon, e.g. "Sentinel: ", and mention the corridor code exactly as given (e.g. "USD-JPY").',
    "- Say what the agent sees and its action. You may include the risk percentage.",
    '- Never use advice words: buy, buying, sell, selling, should, guaranteed, guarantee, "hold on to". No predictions or promises.',
    '- Use the "example" only as a guide to tone and facts; improve on it.',
    "",
    'Reply with a JSON array of {"key": ..., "text": ...}, one per decision, using the given keys.',
    "",
    "Decisions:",
    JSON.stringify(items, null, 1),
  ].join("\n");
}

/** Gemini's structured-output schema for the reply. */
export const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { key: { type: "STRING" }, text: { type: "STRING" } },
    required: ["key", "text"],
  },
} as const;

export interface CheckedExplanations {
  accepted: Record<string, string>;
  rejected: { key: string; reason: string; text?: string }[];
}

/** Validates the model's reply against the plan. Anything missing or invalid is rejected (fallback is used). */
export function checkReply(reply: unknown, plan: PlannedDecision[]): CheckedExplanations {
  const byKey = new Map<string, unknown>();
  if (Array.isArray(reply)) {
    for (const r of reply) {
      if (r && typeof r === "object" && typeof (r as { key?: unknown }).key === "string") {
        const { key, text } = r as { key: string; text?: unknown };
        if (!byKey.has(key)) byKey.set(key, text);
      }
    }
  }
  const out: CheckedExplanations = { accepted: {}, rejected: [] };
  for (const d of plan) {
    const key = explanationKey(d);
    if (!byKey.has(key)) {
      out.rejected.push({ key, reason: "missing from reply" });
      continue;
    }
    const text = byKey.get(key);
    const v: Validation = validateForDecision(text, d);
    if (v.ok) out.accepted[key] = (text as string).trim();
    else out.rejected.push({ key, reason: v.reason, text: typeof text === "string" ? text : undefined });
  }
  return out;
}
