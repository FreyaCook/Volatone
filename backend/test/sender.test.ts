// The pure parts of the devnet sender: memo payload and the size check.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import type { AgentDecisionEvent, PlayerMoveEvent, PlayerOutcomeEvent } from "@volatone/shared";
import { MAX_PER_TX, type Batch } from "../src/chain/batcher";
import {
  assertFits, buildMemoPayload, buildMemoTransaction, compactEvent, explorerUrl, MEMO_MAX_BYTES, TX_SIZE_LIMIT, transactionSize,
} from "../src/chain/sender";

const decision = (id: string): AgentDecisionEvent => ({
  id, t: 12345, type: "agent_decision", agent: "opportunist", corridor: "GBP-USD", risk: 0.123456, action: "reduce",
  explanation: "A long Gemini explanation that must never go on-chain. ".repeat(10),
});
const move: PlayerMoveEvent = { id: "evt_0010", t: 5000, type: "player_move", corridor: "EUR-USD", action: "hedge" };
const outcome: PlayerOutcomeEvent = { id: "evt_0011", t: 9000, type: "player_outcome", moveId: "evt_0010", result: "good", reason: "long text" };
// A real-shaped devnet blockhash (any 32-byte base58 value works for sizing).
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

test("compact records keep ids, types and key fields, and drop free text", () => {
  assert.deepEqual(compactEvent(decision("evt_0001")), { i: "evt_0001", k: "dec", ag: "opportunist", c: "GBP-USD", r: 0.12, a: "reduce" });
  assert.deepEqual(compactEvent(move), { i: "evt_0010", k: "move", c: "EUR-USD", a: "hedge" });
  assert.deepEqual(compactEvent(outcome), { i: "evt_0011", k: "out", m: "evt_0010", res: "good" });
});

test("memo payload is valid JSON, in batch order, with no explanation or reason text", () => {
  const memo = buildMemoPayload([decision("evt_0001"), move, outcome]);
  const parsed = JSON.parse(memo);
  assert.equal(parsed.app, "volatone");
  assert.equal(parsed.v, 1);
  assert.deepEqual(parsed.ev.map((e: { i: string }) => e.i), ["evt_0001", "evt_0010", "evt_0011"]);
  assert.ok(!memo.includes("Gemini") && !memo.includes("long text"));
});

test("empty batch is refused", () => {
  assert.throws(() => buildMemoPayload([]), /empty batch/);
});

test(`a full batch of ${MAX_PER_TX} worst-case events fits well under the 1232-byte limit`, () => {
  // Longest values: 9-char ids, "opportunist", risk with 2 dp.
  const batch: Batch = Array.from({ length: MAX_PER_TX }, (_, i) => decision(`evt_${String(99990 + i)}`));
  const memo = buildMemoPayload(batch);
  const memoBytes = Buffer.byteLength(memo);
  const tx = buildMemoTransaction(memo, Keypair.generate().publicKey, BLOCKHASH);
  const size = assertFits(tx);
  console.log(`  ${MAX_PER_TX} events: memo ${memoBytes} B, tx ${size} B of ${TX_SIZE_LIMIT}`);
  assert.ok(memoBytes <= MEMO_MAX_BYTES);
  assert.ok(size <= TX_SIZE_LIMIT - 300, `expected plenty of headroom, got ${size} B`);
});

test("size check counts the signature and rejects an oversized transaction", () => {
  const payer = Keypair.generate();
  const small = buildMemoTransaction("x", payer.publicKey, BLOCKHASH);
  const unsigned = transactionSize(small);
  small.sign(payer);
  assert.equal(small.serialize().length, unsigned, "size before signing equals size after");
  const huge = buildMemoTransaction("x".repeat(TX_SIZE_LIMIT), payer.publicKey, BLOCKHASH);
  assert.throws(() => assertFits(huge), /too big/);
});

test("oversized memo is refused before building a transaction", () => {
  const batch: Batch = Array.from({ length: 30 }, (_, i) => decision(`evt_${i}`));
  assert.throws(() => buildMemoPayload(batch), /memo too big/);
});

test("Explorer link points at devnet", () => {
  assert.equal(explorerUrl("abc"), "https://explorer.solana.com/tx/abc?cluster=devnet");
});
