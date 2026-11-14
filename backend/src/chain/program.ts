// Client for the volatone_log Anchor program (programs-anchor/), encoded by hand:
// no Anchor client dependency. Layout must match programs-anchor/.../src/lib.rs.
//
//   log_batch data = 8-byte discriminator sha256("global:log_batch")[0..8]
//                  + u32 LE entry count + N x 15-byte entries (Borsh Vec<Entry>)
//   Entry (15 B)   = id u32 | kind u8 | agent u8 | corridor u8 | action u8 | result u8 | risk_bps u16 | ref_id u32
//   Log PDA        = seeds ["log", wallet pubkey]
//
// Everything here is pure except fetchLogCounters (one account read).

import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import type { Batch, LoggableEvent } from "./batcher";

/** Must equal declare_id! in programs-anchor/programs/volatone_log/src/lib.rs (checked by a test). */
export const PROGRAM_ID = new PublicKey("2jHECa8gr3VFYTuBvRxmB4BtX3DasybJFKixp5348HeN");
export const LOG_SEED = Buffer.from("log");
export const ENTRY_BYTES = 15;

const anchorDisc = (preimage: string) => createHash("sha256").update(preimage).digest().subarray(0, 8);
export const LOG_BATCH_DISCRIMINATOR = anchorDisc("global:log_batch");
export const LOG_ACCOUNT_DISCRIMINATOR = anchorDisc("account:LogAccount");

// Enum indexes, in the program's declaration order.
const KIND = { agent_decision: 0, player_move: 1, player_outcome: 2 } as const;
const AGENT = { sentinel: 1, opportunist: 2, strategist: 3 } as const; // 0 = None
const CORRIDOR = { "USD-JPY": 1, "EUR-JPY": 2, "EUR-USD": 3, "GBP-USD": 4 } as const; // 0 = None
const ACTION = { hedge: 1, hold: 2, reduce: 3 } as const; // 0 = None
const RESULT = { good: 1, poor: 2 } as const; // 0 = None

/** "evt_0042" -> 42. Throws on anything else or a value that doesn't fit in a u32. */
export function eventNumber(id: string): number {
  const m = /^evt_(\d+)$/.exec(id);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n) || n > 0xffff_ffff) throw new Error(`bad event id for program log: ${id}`);
  return n;
}

export function encodeEntry(e: LoggableEvent): Buffer {
  const b = Buffer.alloc(ENTRY_BYTES); // unset fields stay 0 = None
  b.writeUInt32LE(eventNumber(e.id), 0);
  b.writeUInt8(KIND[e.type], 4);
  switch (e.type) {
    case "agent_decision":
      b.writeUInt8(AGENT[e.agent], 5);
      b.writeUInt8(CORRIDOR[e.corridor], 6);
      b.writeUInt8(ACTION[e.action], 7);
      b.writeUInt16LE(Math.round(Math.min(1, Math.max(0, e.risk)) * 10_000), 9);
      break;
    case "player_move":
      b.writeUInt8(CORRIDOR[e.corridor], 6);
      b.writeUInt8(ACTION[e.action], 7);
      break;
    case "player_outcome":
      b.writeUInt8(RESULT[e.result], 8);
      b.writeUInt32LE(eventNumber(e.moveId), 11);
      break;
  }
  return b;
}

export function encodeLogBatchData(batch: Batch): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(batch.length, 0);
  return Buffer.concat([LOG_BATCH_DISCRIMINATOR, len, ...batch.map(encodeEntry)]);
}

export function deriveLogPda(wallet: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([LOG_SEED, wallet.toBuffer()], programId)[0];
}

export function buildLogBatchInstruction(batch: Batch, wallet: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true }, // pays for the PDA on first use
      { pubkey: deriveLogPda(wallet), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeLogBatchData(batch),
  });
}

export interface LogCounters {
  decisions: bigint;
  moves: bigint;
  outcomes: bigint;
  batches: bigint;
  lastSlot: bigint;
}

/** Decodes the LogAccount PDA (8 disc + 5 x u64 + bump). Throws if it isn't one. */
export function decodeLogAccount(data: Buffer): LogCounters {
  if (data.length < 8 + 40 + 1 || !data.subarray(0, 8).equals(LOG_ACCOUNT_DISCRIMINATOR)) {
    throw new Error("account is not a volatone_log LogAccount");
  }
  const u64 = (i: number) => data.readBigUInt64LE(8 + i * 8);
  return { decisions: u64(0), moves: u64(1), outcomes: u64(2), batches: u64(3), lastSlot: u64(4) };
}

/** Reads the wallet's log PDA. null if it doesn't exist yet. */
export async function fetchLogCounters(
  connection: Pick<Connection, "getAccountInfo">,
  wallet: PublicKey,
): Promise<LogCounters | null> {
  const info = await connection.getAccountInfo(deriveLogPda(wallet), "confirmed");
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("log PDA is not owned by volatone_log");
  return decodeLogAccount(info.data);
}
