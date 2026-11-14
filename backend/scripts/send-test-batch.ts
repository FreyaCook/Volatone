// Sends one realistic test batch as ONE real devnet transaction, then prints the
// path used (program, or memo fallback), signature, Explorer link and confirmMs.
// After a program send it also reads the log PDA and prints its counters.
//   Default:      3 agent decisions + 1 player move (4 events).
//   --events 8:   a full batch: 6 agent decisions + 1 player outcome + 1 player move.
//                 (Only one move, last: under the batching rule a move flushes at once.)
// Run: npm run send-test-batch -w backend [-- --events 8]
// Force the memo path: LOG_VIA=memo npm run send-test-batch -w backend
// Needs: a funded devnet wallet at WALLET_PATH (default .keys/volatone-wallet.json).
// Optional: SOLANA_RPC_URL in .env (default https://api.devnet.solana.com).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentDecisionEvent, PlayerMoveEvent, PlayerOutcomeEvent, TxConfirmedEvent } from "@volatone/shared";
import { createIdSource } from "../src/ids";
import { MAX_PER_TX, type Batch } from "../src/chain/batcher";
import { Connection } from "@solana/web3.js";
import { buildMemoPayload, configFromEnv, createSender, explorerUrl, loadKeypair, REPO_ROOT } from "../src/chain/sender";
import { deriveLogPda, fetchLogCounters, PROGRAM_ID } from "../src/chain/program";

const { values } = parseArgs({ options: { events: { type: "string", default: "4" } } });
const count = Number(values.events);
if (count !== 4 && count !== MAX_PER_TX) {
  console.error(`--events must be 4 or ${MAX_PER_TX}`);
  process.exit(1);
}

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ids = createIdSource(9001); // test ids, well clear of a normal run's
const decision = (
  agent: AgentDecisionEvent["agent"], corridor: AgentDecisionEvent["corridor"], risk: number, action: AgentDecisionEvent["action"],
): AgentDecisionEvent => ({ id: ids.next(), t: 0, type: "agent_decision", agent, corridor, risk, action, explanation: "test batch" });
const move = (corridor: PlayerMoveEvent["corridor"], action: PlayerMoveEvent["action"]): PlayerMoveEvent =>
  ({ id: ids.next(), t: 0, type: "player_move", corridor, action });
const outcome = (moveId: string, result: PlayerOutcomeEvent["result"]): PlayerOutcomeEvent =>
  ({ id: ids.next(), t: 0, type: "player_outcome", moveId, result, reason: "test batch" });

const batch: Batch =
  count === 4
    ? [
        decision("sentinel", "USD-JPY", 0.71, "hedge"),
        decision("opportunist", "EUR-JPY", 0.48, "hold"),
        decision("strategist", "USD-JPY", 0.66, "reduce"),
        move("USD-JPY", "hedge"),
      ]
    : [
        decision("sentinel", "USD-JPY", 0.71, "hedge"),
        decision("opportunist", "EUR-JPY", 0.48, "hold"),
        decision("strategist", "USD-JPY", 0.66, "reduce"),
        outcome("evt_8999", "good"), // judges an earlier (pretend) move
        decision("sentinel", "GBP-USD", 0.83, "reduce"),
        decision("opportunist", "EUR-USD", 0.37, "hold"),
        decision("strategist", "EUR-JPY", 0.59, "hedge"),
        move("GBP-USD", "reduce"),
      ];

/** Flush stdout/stderr (async when piped on macOS), then exit with the given code. */
async function exit(code: number): Promise<never> {
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  await new Promise<void>((r) => process.stderr.write("", () => r()));
  process.exit(code);
}

const config = configFromEnv();
const memo = buildMemoPayload(batch);
const usingDefaultRpc = !process.env.SOLANA_RPC_URL?.trim();
console.log(`Sending ${batch.length} events in one devnet transaction (${usingDefaultRpc ? "public devnet RPC" : "RPC from .env"})...`);
console.log(config.forceMemo ? "Path: memo (forced by LOG_VIA=memo)" : `Path: program ${PROGRAM_ID.toBase58()}, memo fallback`);
console.log(`Memo fallback payload (${Buffer.byteLength(memo)} bytes): ${memo}`);

const connection = new Connection(config.rpcUrl, "confirmed");
const { event, path, programError } = await createSender(config, { connection }).send(batch, ids, () => 0);
if (programError) console.log(`Program path failed (${programError}); fell back to memo.`);

if (event.type === "tx_failed") {
  console.error(`Failed via ${path}: ${event.error}`);
  await exit(1);
} else {
  try {
    await printSuccess(event);
  } catch (err) {
    console.error(`Sent, but reading the log PDA failed: ${err instanceof Error ? err.message : String(err)}`);
    await exit(1);
  }
  await exit(0); // everything printed: exit so no lingering handle can keep the terminal waiting
}

async function printSuccess(event: TxConfirmedEvent): Promise<void> {
  console.log(`Confirmed via ${path.toUpperCase()}.`);
  console.log(`Signature: ${event.signature}`);
  console.log(`Explorer:  ${explorerUrl(event.signature)}`);
  console.log(`confirmMs: ${event.confirmMs}`);

  if (path === "program") {
    const wallet = loadKeypair(config.walletPath).publicKey; // public key only
    const counters = await fetchLogCounters(connection, wallet);
    const pda = deriveLogPda(wallet).toBase58();
    console.log(`\nOn-chain log PDA ${pda}`);
    console.log(`  https://explorer.solana.com/address/${pda}?cluster=devnet`);
    if (!counters) console.log("  (not found yet)");
    else {
      console.log(`  decisions: ${counters.decisions}`);
      console.log(`  moves:     ${counters.moves}`);
      console.log(`  outcomes:  ${counters.outcomes}`);
      console.log(`  batches:   ${counters.batches}`);
      console.log(`  last slot: ${counters.lastSlot}`);
    }
  }
}
