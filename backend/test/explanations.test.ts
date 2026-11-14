// Explanations: advice-word check on every fallback, the validator, and the cache loader.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, AgentName } from "@volatone/shared";
import {
  buildPrompt, checkReply, EXPLANATIONS_PATH, explanationKey, loadExplanations, parseKey,
} from "../src/agents/explanations";
import { fallbackExplanation, planAgentDecisions, type PlannedDecision } from "../src/agents/runner";
import { containsAdviceWords, validateExplanation, validateForDecision } from "../src/agents/validate";
import { loadStorm } from "../src/storm/committed";
import { CORRIDORS } from "../src/storm/storm";

const plan = planAgentDecisions(loadStorm());

test("no fallback explanation contains advice words (every agent x action x corridor, and the real plan)", () => {
  for (const agent of ["sentinel", "opportunist", "strategist"] as AgentName[]) {
    for (const action of ["hedge", "hold", "reduce"] as Action[]) {
      for (const corridor of CORRIDORS) {
        for (const risk of [0, 0.555, 1]) {
          const text = fallbackExplanation({ second: 1, agent, corridor, risk, action, why: "settled" });
          assert.ok(!containsAdviceWords(text), text);
        }
      }
    }
  }
  for (const d of plan) assert.ok(!containsAdviceWords(fallbackExplanation(d)));
});

test("advice words are caught as whole words, case-insensitively", () => {
  for (const bad of ["Buy now.", "We are buying.", "Time to SELL.", "You should hedge.", "A guaranteed win.", "Hold on to it."]) {
    assert.ok(containsAdviceWords(bad), bad);
  }
  for (const fine of ["Hold for now.", "Business as usual.", "Sellers? No: the word is a noun here.", "Holding steady."]) {
    assert.ok(!containsAdviceWords(fine), fine);
  }
});

test("validator: one sentence, under 160 characters, no advice words", () => {
  assert.deepEqual(validateExplanation("Sentinel: USD-JPY jumped 0.6% in seconds, so adding protection."), { ok: true });
  assert.equal(validateExplanation("").ok, false);
  assert.equal(validateExplanation(42).ok, false);
  assert.equal(validateExplanation("No full stop").ok, false);
  assert.equal(validateExplanation("Two sentences. Here.").ok, false);
  assert.equal(validateExplanation("Line one.\nLine two.").ok, false);
  assert.equal(validateExplanation(`${"a".repeat(159)}.`).ok, false);
  assert.equal(validateExplanation(`${"a".repeat(158)}.`).ok, true);
  assert.match((validateExplanation("You should hedge now.") as { reason: string }).reason, /advice word/);
});

test("per-decision check: agent prefix and corridor", () => {
  const d = { agent: "strategist", corridor: "GBP-USD" } as const;
  assert.equal(validateForDecision("Strategist: GBP-USD looks calm enough now.", d).ok, true);
  assert.equal(validateForDecision("Sentinel: GBP-USD looks calm enough now.", d).ok, false);
  assert.equal(validateForDecision("Strategist: the map looks calm enough now.", d).ok, false);
});

test("keys round-trip", () => {
  for (const d of plan) assert.deepEqual(parseKey(explanationKey(d)), { second: d.second, agent: d.agent, corridor: d.corridor });
  assert.equal(parseKey("x:sentinel:USD-JPY"), null);
});

test("the prompt covers every planned decision once", () => {
  const prompt = buildPrompt(plan);
  for (const d of plan) assert.equal(prompt.split(`"${explanationKey(d)}"`).length - 1, 1, explanationKey(d));
});

test("checkReply keeps only valid explanations; missing or bad ones fall back", () => {
  const [a, b, c] = plan;
  const name = (d: PlannedDecision) => d.agent[0].toUpperCase() + d.agent.slice(1);
  const reply = [
    { key: explanationKey(a), text: `${name(a)}: ${a.corridor} is on the move, so I'm acting.` },
    { key: explanationKey(b), text: `${name(b)}: ${b.corridor} looks rough, you should buy protection.` },
    { key: "nonsense", text: "x." },
  ];
  const out = checkReply(reply, plan);
  assert.deepEqual(Object.keys(out.accepted), [explanationKey(a)]);
  assert.equal(out.rejected.length, plan.length - 1);
  assert.match(out.rejected.find((r) => r.key === explanationKey(b))!.reason, /advice word/);
  assert.equal(out.rejected.find((r) => r.key === explanationKey(c))!.reason, "missing from reply");
  for (const text of Object.values(out.accepted)) assert.equal(validateExplanation(text).ok, true);
  assert.deepEqual(checkReply("not an array", plan).accepted, {});
});

test("loader drops cached texts that fail validation, so the engine falls back", () => {
  const [a, b] = plan;
  const name = (d: PlannedDecision) => d.agent[0].toUpperCase() + d.agent.slice(1);
  const dir = mkdtempSync(join(tmpdir(), "volatone-"));
  const path = join(dir, "explanations.json");
  writeFileSync(path, JSON.stringify({
    model: "test", generatedAt: "2026-11-14",
    explanations: {
      [explanationKey(a)]: `${name(a)}: ${a.corridor} is moving, so I'm acting.`,
      [explanationKey(b)]: `${name(b)}: ${b.corridor} is a guaranteed win.`,
    },
  }));
  const { texts } = loadExplanations(path);
  assert.deepEqual([...texts.keys()], [explanationKey(a)]);
  assert.equal(loadExplanations(join(dir, "missing.json")).texts.size, 0);
});

test("the committed explanations.json (if any) passes validation in full", () => {
  if (!existsSync(EXPLANATIONS_PATH)) return;
  const { texts, source } = loadExplanations();
  assert.doesNotMatch(source, /rejected|unreadable/, source);
  for (const [key, text] of texts) {
    assert.ok(plan.some((d) => explanationKey(d) === key), `stale key ${key}`);
    assert.equal(validateExplanation(text).ok, true, text);
  }
});
