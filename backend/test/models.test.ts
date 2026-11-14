// Gemini model selection for make-explanations.ts, on a fake model list. No network.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import { isEligible, rankModels, type ModelInfo } from "../src/agents/models";

const gen = ["generateContent", "countTokens"];
const m = (id: string, methods = gen): ModelInfo => ({ name: `models/${id}`, supportedGenerationMethods: methods });

const FAKE: ModelInfo[] = [
  m("gemini-3.8-flash-lite-tts"),
  m("gemini-3.8-flash-native-audio-preview"),
  m("gemini-3.8-flash-image"),
  m("gemini-3.8-flash-live"),
  m("gemini-3.8-flash-lite-preview-11-2026"),
  m("gemini-3.8-flash-thinking"),
  m("gemini-3.8-flash-computer-use"),
  m("gemini-3.8-flash-robotics"),
  m("gemini-embedding-002", ["embedContent"]),
  m("gemini-3.8-flash-embedding"),
  m("gemini-3.8-flash-audio"),
  m("gemini-3.8-pro"),
  m("gemini-3.8-flash"),
  m("gemini-3.5-flash-lite"),
  m("gemini-3.5-flash-lite-001"),
  m("gemini-3.0-flash-lite"),
  m("gemini-3.5-flash-exp"),
  m("gemini-3.9-flash-lite", ["countTokens"]), // no generateContent
  { name: "models/gemini-3.9-flash" },         // no methods listed
];

test("only generateContent Flash / Flash-Lite text models are eligible", () => {
  const eligible = FAKE.filter(isEligible).map((x) => x.name.slice(7));
  assert.deepEqual(eligible.sort(), [
    "gemini-3.0-flash-lite",
    "gemini-3.5-flash-exp",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash-lite-001",
    "gemini-3.8-flash",
    "gemini-3.8-flash-lite-preview-11-2026",
  ]);
});

test("ranking: stable Flash-Lite (newest, base name first), then stable Flash, then previews", () => {
  assert.deepEqual(rankModels(FAKE), [
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash-lite-001",
    "gemini-3.0-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.8-flash-lite-preview-11-2026",
    "gemini-3.5-flash-exp",
  ]);
});

test("the TTS model that broke the first run is never chosen", () => {
  assert.notEqual(rankModels(FAKE)[0], "gemini-3.8-flash-lite-tts");
  assert.ok(!rankModels(FAKE).some((id) => id.includes("tts")));
});

test("with no stable Flash-Lite, a stable Flash text model comes first", () => {
  assert.deepEqual(rankModels([m("gemini-3.8-flash-lite-tts"), m("gemini-3.8-flash-lite-preview"), m("gemini-3.8-flash")]),
    ["gemini-3.8-flash", "gemini-3.8-flash-lite-preview"]);
});

test("nothing eligible gives an empty list", () => {
  assert.deepEqual(rankModels([m("gemini-3.8-flash-lite-tts"), m("gemini-3.8-pro")]), []);
});
