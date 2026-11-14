// The volatone_log program client (pure parts) and the program -> memo fallback.
// Run: npm test -w backend

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { AgentDecisionEvent, PlayerMoveEvent, PlayerOutcomeEvent } from "@volatone/shared";
import type { Batch } from "../src/chain/batcher";
import { createIdSource } from "../src/ids";
import {
  decodeLogAccount, deriveLogPda, encodeEntry, encodeLogBatchData, ENTRY_BYTES, eventNumber,
  LOG_ACCOUNT_DISCRIMINATOR, LOG_BATCH_DISCRIMINATOR, PROGRAM_ID,
} from "../src/chain/program";
import {
  assertFits, buildProgramTransaction, createSender, MEMO_PROGRAM_ID, REPO_ROOT, type ChainConnection, type SenderConfig,
} from "../src/chain/sender";

const decision: AgentDecisionEvent = {
  id: "evt_0042", t: 0, type: "agent_decision", agent: "opportunist", corridor: "EUR-USD", risk: 0.7123, action: "reduce", explanation: "x",
};
const move: PlayerMoveEvent = { id: "evt_0043", t: 0, type: "player_move", corridor: "GBP-USD", action: "hedge" };
const outcome: PlayerOutcomeEvent = { id: "evt_0050", t: 0, type: "player_outcome", moveId: "evt_0043", result: "poor", reason: "x" };
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

// ---------- Encoding ----------

test("event ids convert to numbers", () => {
  assert.equal(eventNumber("evt_0042"), 42);
  assert.equal(eventNumber("evt_9001"), 9001);
  assert.equal(eventNumber("evt_12345"), 12345);
  for (const bad of ["42", "evt_", "evt_-1", "evt_1.5", "EVT_0001", "evt_4294967296"]) {
    assert.throws(() => eventNumber(bad), /bad event id/, bad);
  }
});

test("a decision entry is 15 bytes in the program's layout", () => {
  const b = encodeEntry(decision);
  assert.equal(b.length, ENTRY_BYTES);
  assert.deepEqual([...b], [
    42, 0, 0, 0, // id u32 LE
    0,           // kind Decision
    2,           // agent Opportunist
    3,           // corridor EurUsd
    3,           // action Reduce
    0,           // result None
    0xd3, 0x1b,  // risk_bps 7123 = 0x1bd3, u16 LE
    0, 0, 0, 0,  // ref_id
  ]);
});

test("move and outcome entries fill only their own fields", () => {
  assert.deepEqual([...encodeEntry(move)], [43, 0, 0, 0, 1, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeEntry(outcome)], [50, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 43, 0, 0, 0]);
});

test("log_batch data = IDL discriminator + u32 count + 15-byte entries", () => {
  assert.deepEqual([...LOG_BATCH_DISCRIMINATOR], [109, 72, 45, 101, 56, 74, 96, 207]); // from target/idl
  assert.deepEqual([...LOG_ACCOUNT_DISCRIMINATOR], [21, 166, 62, 121, 167, 196, 176, 195]);
  const data = encodeLogBatchData([decision, move, outcome]);
  assert.equal(data.length, 8 + 4 + 3 * ENTRY_BYTES);
  assert.equal(data.readUInt32LE(8), 3);
  assert.deepEqual(data.subarray(12, 27), encodeEntry(decision));
});

test("PROGRAM_ID matches declare_id! in the Anchor program", () => {
  const src = readFileSync(`${REPO_ROOT}/programs-anchor/programs/volatone_log/src/lib.rs`, "utf8");
  assert.equal(/declare_id!\("(\w+)"\)/.exec(src)?.[1], PROGRAM_ID.toBase58());
});

test("log PDA is derived from 'log' + the wallet pubkey, off-curve, one per wallet", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("log"), a.toBuffer()], PROGRAM_ID);
  assert.ok(deriveLogPda(a).equals(expected));
  assert.ok(!PublicKey.isOnCurve(deriveLogPda(a).toBytes()));
  assert.ok(!deriveLogPda(a).equals(deriveLogPda(b)));
});

test("program tx: one log_batch instruction, no compute-budget instruction, fits for 8 entries", () => {
  const wallet = Keypair.generate().publicKey;
  const batch: Batch = Array.from({ length: 8 }, (_, i) => ({ ...decision, id: `evt_${99990 + i}` }));
  const tx = buildProgramTransaction(batch, wallet, BLOCKHASH);
  assert.equal(tx.instructions.length, 1);
  const [ix] = tx.instructions;
  assert.ok(ix.programId.equals(PROGRAM_ID));
  assert.ok(!ix.programId.equals(ComputeBudgetProgram.programId));
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
    [wallet.toBase58(), true, true],
    [deriveLogPda(wallet).toBase58(), false, true],
    [SystemProgram.programId.toBase58(), false, false],
  ]);
  assert.ok(assertFits(tx) < 500);
});

test("LogAccount decodes counters; anything else is rejected", () => {
  const data = Buffer.alloc(8 + 40 + 1);
  LOG_ACCOUNT_DISCRIMINATOR.copy(data, 0);
  [9n, 2n, 1n, 2n, 123456n].forEach((v, i) => data.writeBigUInt64LE(v, 8 + i * 8));
  assert.deepEqual(decodeLogAccount(data), { decisions: 9n, moves: 2n, outcomes: 1n, batches: 2n, lastSlot: 123456n });
  assert.throws(() => decodeLogAccount(Buffer.alloc(49)), /not a volatone_log/);
});

// ---------- Fallback (fake connection, no network) ----------

function fakeConnection(fail: { program?: boolean; memo?: boolean }) {
  const sent: ("program" | "memo")[] = [];
  const connection: ChainConnection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    sendRawTransaction: async (raw) => {
      const ixs = Transaction.from(raw as Buffer).instructions;
      const path = ixs.some((ix) => ix.programId.equals(PROGRAM_ID)) ? "program"
        : ixs.some((ix) => ix.programId.equals(MEMO_PROGRAM_ID)) ? "memo" : assert.fail("unknown tx");
      sent.push(path);
      if (fail[path]) throw new Error(`Simulation failed: ${path} unavailable`);
      return `sig_${path}`;
    },
    confirmTransaction: (async () => ({ context: { slot: 1 }, value: { err: null } })) as ChainConnection["confirmTransaction"],
  };
  return { connection, sent };
}

const payer = Keypair.generate();
const config = (forceMemo = false): SenderConfig => ({ rpcUrl: "http://fake", walletPath: "/nonexistent", forceMemo });
const send = (c: ChainConnection, forceMemo = false) =>
  createSender(config(forceMemo), { connection: c, loadPayer: () => payer }).send([decision, move], createIdSource(1), () => 7);

test("program path is used by default when it works", async () => {
  const { connection, sent } = fakeConnection({});
  const r = await send(connection);
  assert.deepEqual(sent, ["program"]);
  assert.equal(r.path, "program");
  assert.equal(r.programError, undefined);
  assert.equal(r.event.type, "tx_confirmed");
  assert.equal(r.event.type === "tx_confirmed" && r.event.signature, "sig_program");
  assert.deepEqual(r.event.eventIds, ["evt_0042", "evt_0043"]);
});

test("a failed program send falls back to memo", async () => {
  const { connection, sent } = fakeConnection({ program: true });
  const r = await send(connection);
  assert.deepEqual(sent, ["program", "memo"]);
  assert.equal(r.path, "memo");
  assert.match(r.programError ?? "", /program unavailable/);
  assert.equal(r.event.type === "tx_confirmed" && r.event.signature, "sig_memo");
  assert.equal(r.event.t, 7);
});

test("LOG_VIA=memo skips the program entirely", async () => {
  const { connection, sent } = fakeConnection({});
  const r = await send(connection, true);
  assert.deepEqual(sent, ["memo"]);
  assert.equal(r.path, "memo");
});

test("if both paths fail, the result is tx_failed with both reasons available", async () => {
  const { connection, sent } = fakeConnection({ program: true, memo: true });
  const r = await send(connection);
  assert.deepEqual(sent, ["program", "memo"]);
  assert.equal(r.event.type, "tx_failed");
  assert.match(r.event.type === "tx_failed" ? r.event.error : "", /memo unavailable/);
  assert.match(r.programError ?? "", /program unavailable/);
});
