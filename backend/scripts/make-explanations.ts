// Makes the cached agent explanations with ONE Gemini request, then writes
// backend/src/agents/explanations.json (model name, generation date, validated texts).
//
//  - Reads GEMINI_API_KEY from the repo's .env (via Node's loadEnvFile) or the environment.
//    The key is only sent in the x-goog-api-key header: never printed, logged or put in a URL.
//  - Picks a Flash-Lite model by listing the models the API offers (stable over preview,
//    newest version first). Override with --model <name>.
//  - Every explanation is validated (one sentence, under 160 chars, no advice words, starts with
//    the agent's name, names the corridor). Any that fail are left out, so the engine keeps using
//    the plain-English fallback for those decisions.
//
// Run:        npm run make-explanations -w backend
// Options:    --model gemini-x.y-flash-lite   use this model instead of auto-picking
//             --dry-run                       print the prompt and exit (no key, no request)

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planAgentDecisions } from "../src/agents/runner";
import {
  buildPrompt, checkReply, EXPLANATIONS_PATH, RESPONSE_SCHEMA, type ExplanationsFile,
} from "../src/agents/explanations";
import { REPO_ROOT } from "../src/chain/sender";
import { loadStorm } from "../src/storm/committed";

const API = "https://generativelanguage.googleapis.com/v1beta";

const { values } = parseArgs({
  options: { model: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});

const plan = planAgentDecisions(loadStorm());
const prompt = buildPrompt(plan);

if (values["dry-run"]) {
  console.log(prompt);
  process.exit(0);
}

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set (add it to the .env file in the repo root).");
  process.exit(1);
}
const headers = { "x-goog-api-key": apiKey, "content-type": "application/json" };

/** A short error from a failed API response. Never includes the key (it is only in a header). */
async function apiError(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  return new Error(`${what} failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`);
}

interface ModelInfo {
  name: string; // "models/gemini-2.5-flash-lite"
  supportedGenerationMethods?: string[];
}

async function listModels(): Promise<ModelInfo[]> {
  const all: ModelInfo[] = [];
  let pageToken = "";
  do {
    const url = `${API}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw await apiError(res, "listing models");
    const body = (await res.json()) as { models?: ModelInfo[]; nextPageToken?: string };
    all.push(...(body.models ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return all;
}

/** Newest stable Flash-Lite model that supports generateContent (preview/experimental only if nothing else). */
function pickFlashLite(models: ModelInfo[]): string | null {
  const ids = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((id) => /flash-lite/i.test(id));
  const version = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const unstable = (id: string) => /preview|exp/i.test(id);
  ids.sort(
    (a, b) =>
      Number(unstable(a)) - Number(unstable(b)) || version(b) - version(a) || a.length - b.length || a.localeCompare(b),
  );
  return ids[0] ?? null;
}

async function generate(model: string): Promise<unknown> {
  const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    }),
  });
  if (!res.ok) throw await apiError(res, `generateContent (${model})`);
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error(`model returned no text (finishReason: ${body.candidates?.[0]?.finishReason ?? "none"})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("model reply was not valid JSON");
  }
}

try {
  let model = values.model?.replace(/^models\//, "");
  if (!model) {
    const models = await listModels();
    model = pickFlashLite(models) ?? undefined;
    if (!model) throw new Error(`no Flash-Lite model with generateContent among ${models.length} models; pass --model`);
  }
  console.log(`Model: ${model}`);
  console.log(`Asking for ${plan.length} explanations in one request...`);

  const checked = checkReply(await generate(model), plan);
  const file: ExplanationsFile = { model, generatedAt: new Date().toISOString(), explanations: checked.accepted };
  writeFileSync(EXPLANATIONS_PATH, JSON.stringify(file, null, 2) + "\n");

  const ok = Object.keys(checked.accepted).length;
  console.log(`Accepted ${ok} of ${plan.length}; ${checked.rejected.length} will use the fallback text.`);
  for (const r of checked.rejected) console.log(`  rejected ${r.key}: ${r.reason}${r.text ? `  "${r.text}"` : ""}`);
  console.log(`Wrote ${EXPLANATIONS_PATH}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
