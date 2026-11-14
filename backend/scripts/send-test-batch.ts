// Sends one realistic test batch as ONE real devnet transaction, then prints the
// signature, an Explorer link and confirmMs.
//   Default:      3 agent decisions + 1 player move (4 events).
//   --events 8:   a full batch: 6 agent decisions + 1 player outcome + 1 player move.
//                 (Only one move, last: under the batching rule a move flushes at once.)
// Run: npm run send-test-batch -w backend [-- --events 8]
// Needs: a funded devnet wallet at WALLET_PATH (default .keys/volatone-wallet.json).
// Optional: SOLANA_RPC_URL in .env (default https://api.devnet.solana.com).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentDecisionEvent, PlayerMoveEvent, PlayerOutcomeEvent } from "@volatone/shared";
import { createIdSource } from "../src/ids";
import { MAX_PER_TX, type Batch } from "../src/chain/batcher";
import { buildMemoPayload, configFromEnv, createSender, explorerUrl, REPO_ROOT } from "../src/chain/sender";

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

const memo = buildMemoPayload(batch);
const usingDefaultRpc = !process.env.SOLANA_RPC_URL?.trim();
console.log(`Sending ${batch.length} events in one devnet transaction (${usingDefaultRpc ? "public devnet RPC" : "RPC from .env"})...`);
console.log(`Memo (${Buffer.byteLength(memo)} bytes): ${memo}`);

const result = await createSender(configFromEnv()).send(batch, ids, () => 0);
if (result.type === "tx_confirmed") {
  console.log(`Confirmed.`);
  console.log(`Signature: ${result.signature}`);
  console.log(`Explorer:  ${explorerUrl(result.signature)}`);
  console.log(`confirmMs: ${result.confirmMs}`);
} else {
  console.error(`Failed: ${result.error}`);
  process.exitCode = 1;
}
