// Sends ONE batch as ONE real Solana devnet transaction: a single Memo instruction
// holding a compact JSON record of the batch's events (ids, types, key fields; no text).
//
//  - Signs with the keypair file at WALLET_PATH (default .keys/volatone-wallet.json).
//    The secret key is only ever held in memory: never printed, logged or put in an error.
//  - RPC: SOLANA_RPC_URL (default https://api.devnet.solana.com).
//  - confirmMs is our own measurement: from sending the signed tx to "confirmed" commitment.
//  - Always resolves: a tx_confirmed event on success, a tx_failed event on failure.
//
// The memo payload and transaction building are pure (no network) so they can be tested.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";
import type { TxConfirmedEvent, TxFailedEvent } from "@volatone/shared";
import type { IdSource } from "../ids";
import type { Batch, LoggableEvent } from "./batcher";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_WALLET_PATH = ".keys/volatone-wallet.json";
/** Solana's hard limit for a serialized transaction. */
export const TX_SIZE_LIMIT = 1232;
/** Our own cap on the memo, well under what fits (~1020 bytes with one signer + compute budget). */
export const MEMO_MAX_BYTES = 800;
/**
 * Memo compute cost grows with memo length (measured: 128,240 CU for a 324-byte memo),
 * so a full 8-event batch could pass the 200,000 default. Raise the cap; no priority fee.
 */
export const COMPUTE_UNIT_LIMIT = 400_000;
const COMMITMENT: Commitment = "confirmed";

/** Repo root (backend/src/chain -> ../../..). Relative paths are resolved from here. */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

// ---------- Memo payload (pure) ----------

/**
 * One event as a compact record. Short keys, readable values, no free text:
 *   decision: { i, k:"dec",  ag, c, r, a }   (agent, corridor, risk 0..1 to 2 dp, action)
 *   move:     { i, k:"move", c, a }
 *   outcome:  { i, k:"out",  m, res }        (moveId, result)
 */
export function compactEvent(e: LoggableEvent): Record<string, string | number> {
  switch (e.type) {
    case "agent_decision":
      return { i: e.id, k: "dec", ag: e.agent, c: e.corridor, r: Math.round(e.risk * 100) / 100, a: e.action };
    case "player_move":
      return { i: e.id, k: "move", c: e.corridor, a: e.action };
    case "player_outcome":
      return { i: e.id, k: "out", m: e.moveId, res: e.result };
  }
}

/** The memo text for a batch: {"app":"volatone","v":1,"ev":[...]}. Throws if empty or too big. */
export function buildMemoPayload(batch: Batch): string {
  if (batch.length === 0) throw new Error("empty batch: nothing to log");
  const memo = JSON.stringify({ app: "volatone", v: 1, ev: batch.map(compactEvent) });
  const bytes = Buffer.byteLength(memo, "utf8");
  if (bytes > MEMO_MAX_BYTES) throw new Error(`memo too big: ${bytes} bytes (max ${MEMO_MAX_BYTES})`);
  return memo;
}

// ---------- Transaction (pure) ----------

export function buildMemoTransaction(memo: string, payer: PublicKey, recentBlockhash: string): Transaction {
  const tx = new Transaction({ feePayer: payer, recentBlockhash });
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, "utf8"),
    }),
  );
  return tx;
}

/** Serialized size in bytes of a one-signer tx (signature slot counted even if unsigned). */
export function transactionSize(tx: Transaction): number {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

/** Throws if the transaction would exceed Solana's size limit. */
export function assertFits(tx: Transaction): number {
  let size: number;
  try {
    size = transactionSize(tx);
  } catch {
    // web3.js can't even serialize past its 1232-byte buffer (RangeError / "too large").
    throw new Error(`transaction too big: over the ${TX_SIZE_LIMIT}-byte limit`);
  }
  if (size > TX_SIZE_LIMIT) throw new Error(`transaction too big: ${size} bytes (limit ${TX_SIZE_LIMIT})`);
  return size;
}

// ---------- Config and wallet ----------

export interface SenderConfig {
  rpcUrl: string;
  walletPath: string; // absolute
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SenderConfig {
  const rpcUrl = env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const raw = env.WALLET_PATH?.trim() || DEFAULT_WALLET_PATH;
  return { rpcUrl, walletPath: isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw) };
}

/** Loads a Solana CLI keypair file (JSON array of 64 bytes). Errors never include file contents. */
export function loadKeypair(path: string): Keypair {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`wallet file not found or unreadable at WALLET_PATH (${path})`);
  }
  try {
    const bytes = JSON.parse(text);
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    // Deliberately generic: JSON/key errors can quote the file, which would leak the key.
    throw new Error("wallet file is not a valid Solana keypair (expected a JSON array of 64 numbers)");
  } finally {
    text = "";
  }
}

/** Turns RPC errors into a short, human-readable message. */
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no record of a prior credit|insufficient (funds|lamports)/i.test(msg)) {
    return "wallet has no devnet SOL: fund it (e.g. solana airdrop 1 <address> --url devnet)";
  }
  if (/block height exceeded|blockhash not found/i.test(msg)) return "transaction expired before confirming";
  if (/429|too many requests/i.test(msg)) return "RPC rate limit (429): try again shortly";
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

// ---------- Sending (network) ----------

export interface Sender {
  /** Sends one batch as one tx. Always resolves with a tx_confirmed or tx_failed event. */
  send(batch: Batch, ids: IdSource, replayT: () => number): Promise<TxConfirmedEvent | TxFailedEvent>;
}

export function createSender(config: SenderConfig = configFromEnv()): Sender {
  const connection = new Connection(config.rpcUrl, COMMITMENT);
  let payer: Keypair | undefined; // loaded on first send, kept in memory only

  return {
    async send(batch, ids, replayT) {
      const eventIds = batch.map((e) => e.id);
      try {
        payer ??= loadKeypair(config.walletPath);
        const memo = buildMemoPayload(batch);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);
        const tx = buildMemoTransaction(memo, payer.publicKey, blockhash);
        assertFits(tx);
        tx.sign(payer);
        const raw = tx.serialize();

        const started = performance.now();
        const signature = await connection.sendRawTransaction(raw, { preflightCommitment: COMMITMENT });
        const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, COMMITMENT);
        const confirmMs = Math.round(performance.now() - started);
        if (result.value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(result.value.err)}`);

        return { id: ids.next(), t: replayT(), type: "tx_confirmed", signature, eventIds, confirmMs };
      } catch (err) {
        return { id: ids.next(), t: replayT(), type: "tx_failed", eventIds, error: describeError(err) };
      }
    },
  };
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
