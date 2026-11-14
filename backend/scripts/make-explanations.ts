// Makes the cached agent explanations with ONE Gemini request, then writes
// backend/src/agents/explanations.json (model name, generation date, validated texts).
//
//  - Reads GEMINI_API_KEY from the repo's .env (via Node's loadEnvFile) or the environment.
//    The key is only sent in the x-goog-api-key header: never printed, logged or put in a URL.
//  - Picks a model by listing the models the API offers (see src/agents/models.ts): a stable
//    Flash-Lite text model first, then a stable Flash text model. If a request fails with HTTP 400
//    (e.g. the model doesn't support JSON mode), it tries the next eligible model: at most
//    MAX_ATTEMPTS requests in total. --model <name> uses only that model.
//  - Every explanation is validated (one sentence, under 160 chars, no advice words, starts with
//    the agent's name, names the corridor). Any that fail are left out, so the engine keeps using
//    the plain-English fallback for those decisions.
//
// Run:        npm run make-explanations -w backend
// Options:    --list-models                   print the eligible models and the one that would be chosen
//             --model gemini-x.y-flash-lite   use only this model instead of auto-picking
//             --dry-run                       print the prompt and exit (no key, no request)

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planAgentDecisions } from "../src/agents/runner";
import {
  buildPrompt, checkReply, EXPLANATIONS_PATH, RESPONSE_SCHEMA, type ExplanationsFile,
} from "../src/agents/explanations";
import { rankModels, type ModelInfo } from "../src/agents/models";
import { REPO_ROOT } from "../src/chain/sender";
import { loadStorm } from "../src/storm/committed";

const API = "https://generativelanguage.googleapis.com/v1beta";
/** Total generateContent requests allowed per run (stays well inside free-tier limits). */
const MAX_ATTEMPTS = 3;

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    "list-models": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
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

/** An API failure; `status` lets us retry the next model on a 400. */
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A short error from a failed API response. Never includes the key (it is only in a header). */
async function apiError(res: Response, what: string): Promise<ApiError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  return new ApiError(`${what} failed: HTTP ${res.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`, res.status);
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
  let candidates: string[];
  if (values.model && !values["list-models"]) {
    candidates = [values.model.replace(/^models\//, "")];
  } else {
    const models = await listModels();
    candidates = rankModels(models);
    if (values["list-models"]) {
      console.log(`Eligible models (${candidates.length} of ${models.length}), best first:`);
      for (const [i, id] of candidates.entries()) {
        const note = i === 0 ? "   <- would be chosen" : i < MAX_ATTEMPTS ? "   (next try after a 400 error)" : "";
        console.log(`  ${id}${note}`);
      }
      if (values.model) console.log(`(--model ${values.model} would override this choice.)`);
      process.exit(0);
    }
    if (candidates.length === 0) throw new Error(`no eligible Flash-Lite or Flash text model among ${models.length} models; pass --model`);
  }

  let reply: unknown;
  let model = "";
  const attempts = candidates.slice(0, MAX_ATTEMPTS);
  for (const [i, id] of attempts.entries()) {
    console.log(`Attempt ${i + 1}/${attempts.length}: ${id}, asking for ${plan.length} explanations in one request...`);
    try {
      reply = await generate(id);
      model = id;
      break;
    } catch (err) {
      const last = i === attempts.length - 1;
      if (err instanceof ApiError && err.status === 400 && !last) {
        console.log(`  ${err.message}; trying the next model.`);
        continue;
      }
      throw err;
    }
  }
  console.log(`Model that worked: ${model}`);

  const checked = checkReply(reply, plan);
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
