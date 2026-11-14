// Cached Gemini explanations (explanations.json, written by scripts/make-explanations.ts).
// Missing file or entries => the plain-English fallback in runner.ts is used.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXPLANATIONS_PATH = fileURLToPath(new URL("./explanations.json", import.meta.url));

export interface ExplanationsFile {
  model: string;
  generatedAt: string; // ISO date
  explanations: Record<string, string>; // explanationKey() -> text
}

export function loadExplanations(path = EXPLANATIONS_PATH): { texts: Map<string, string>; source: string } {
  if (!existsSync(path)) return { texts: new Map(), source: "explanations: none cached, using fallback text" };
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as ExplanationsFile;
    const texts = new Map(Object.entries(file.explanations ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0));
    return { texts, source: `explanations: ${texts.size} cached (${file.model}, ${file.generatedAt})` };
  } catch {
    return { texts: new Map(), source: "explanations: file unreadable, using fallback text" };
  }
}
