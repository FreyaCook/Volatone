// Checks for agent explanations (Gemini text and the plain-English fallbacks).
//  - containsAdviceWords: applies to every explanation, fallbacks included.
//  - validateExplanation: the full check for generated text (one sentence, under 160 characters,
//    no advice words). validateForDecision adds: starts with "<Agent>: " and names the corridor,
//    so a cached text can't be attached to the wrong decision.

import type { AgentName, Corridor } from "@volatone/shared";

export const MAX_EXPLANATION_CHARS = 160; // "under 160" => at most 159

/** Advice words (and their obvious forms). Matched as whole words, case-insensitive. */
export const ADVICE_PATTERN =
  /\b(buy|buys|buying|sell|sells|selling|guarantee|guaranteed|guarantees|should)\b|\bhold(ing)? on to\b/i;

export const AGENT_LABEL: Record<AgentName, string> = {
  sentinel: "Sentinel",
  opportunist: "Opportunist",
  strategist: "Strategist",
};

export function containsAdviceWords(text: string): boolean {
  return ADVICE_PATTERN.test(text);
}

export type Validation = { ok: true } | { ok: false; reason: string };

/** One sentence: ends with . ! or ?, and no sentence break (". X") or line break inside. */
export function isOneSentence(text: string): boolean {
  const t = text.trim();
  if (!/[.!?]$/.test(t) || /[\r\n]/.test(t)) return false;
  return !/[.!?]["')]?\s+\S/.test(t.slice(0, -1));
}

export function validateExplanation(text: unknown): Validation {
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, reason: "empty" };
  const t = text.trim();
  if (t.length >= MAX_EXPLANATION_CHARS) return { ok: false, reason: `too long (${t.length} chars)` };
  if (!isOneSentence(t)) return { ok: false, reason: "not exactly one sentence" };
  const m = ADVICE_PATTERN.exec(t);
  if (m) return { ok: false, reason: `advice word "${m[0]}"` };
  return { ok: true };
}

export function validateForDecision(text: unknown, d: { agent: AgentName; corridor: Corridor }): Validation {
  const v = validateExplanation(text);
  if (!v.ok) return v;
  const t = (text as string).trim();
  if (!t.startsWith(`${AGENT_LABEL[d.agent]}: `)) return { ok: false, reason: `must start with "${AGENT_LABEL[d.agent]}: "` };
  if (!t.includes(d.corridor)) return { ok: false, reason: `must mention ${d.corridor}` };
  return { ok: true };
}
