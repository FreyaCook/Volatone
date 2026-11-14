// Choosing a Gemini model for make-explanations.ts. Pure: takes the API's model list, no network.
//
// Eligible: supports generateContent, is a Gemini Flash or Flash-Lite model, and is a plain text
// model (name contains none of EXCLUDED_NAME_PARTS: speech, audio, image, live, embedding,
// robotics, computer-use, thinking-only variants).
// Order: stable Flash-Lite, stable Flash, preview/experimental Flash-Lite, preview/experimental
// Flash; within each, newest version first, then the shortest (base) name.

export interface ModelInfo {
  name: string; // "models/gemini-2.5-flash-lite"
  supportedGenerationMethods?: string[];
}

export const EXCLUDED_NAME_PARTS = [
  "tts", "audio", "native-audio", "image", "live", "embedding", "robotics", "computer-use", "thinking",
] as const;

const idOf = (m: ModelInfo) => m.name.replace(/^models\//, "");
const isLite = (id: string) => /flash-lite/i.test(id);
const isUnstable = (id: string) => /preview|exp/i.test(id);
const version = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/i.exec(id)?.[1] ?? 0);

export function isEligible(m: ModelInfo): boolean {
  const id = idOf(m).toLowerCase();
  if (!m.supportedGenerationMethods?.includes("generateContent")) return false;
  if (!/^gemini-.*flash/.test(id)) return false;
  return !EXCLUDED_NAME_PARTS.some((part) => id.includes(part));
}

/** Eligible model ids, best first. */
export function rankModels(models: ModelInfo[]): string[] {
  const tier = (id: string) => (isUnstable(id) ? 2 : 0) + (isLite(id) ? 0 : 1);
  return [...new Set(models.filter(isEligible).map(idOf))].sort(
    (a, b) => tier(a) - tier(b) || version(b) - version(a) || a.length - b.length || a.localeCompare(b),
  );
}
