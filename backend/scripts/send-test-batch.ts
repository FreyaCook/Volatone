// Sends one realistic test batch (3 agent decisions + 1 player move) as ONE real
// devnet transaction, then prints the signature, an Explorer link and confirmMs.
// Run: npm run send-test-batch -w backend
// Needs: a funded devnet wallet at WALLET_PATH (default .keys/volatone-wallet.json).
// Optional: SOLANA_RPC_URL in .env (default https://api.devnet.solana.com).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentDecisionEvent, PlayerMoveEvent } from "@volatone/shared";
import { createIdSource } from "../src/ids";
import type { Batch } from "../src/chain/batcher";
import { buildMemoPayload, configFromEnv, createSender, explorerUrl, REPO_ROOT } from "../src/chain/sender";

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ids = createIdSource(9001); // test ids, well clear of a normal run's
const decision = (
  agent: AgentDecisionEvent["agent"], corridor: AgentDecisionEvent["corridor"], risk: number, action: AgentDecisionEvent["action"],
): AgentDecisionEvent => ({ id: ids.next(), t: 0, type: "agent_decision", agent, corridor, risk, action, explanation: "test batch" });

const batch: Batch = [
  decision("sentinel", "USD-JPY", 0.71, "hedge"),
  decision("opportunist", "EUR-JPY", 0.48, "hold"),
  decision("strategist", "USD-JPY", 0.66, "reduce"),
  { id: ids.next(), t: 0, type: "player_move", corridor: "USD-JPY", action: "hedge" } satisfies PlayerMoveEvent,
];

const config = configFromEnv();
const usingDefaultRpc = !process.env.SOLANA_RPC_URL?.trim();
console.log(`Sending ${batch.length} events in one devnet transaction (${usingDefaultRpc ? "public devnet RPC" : "RPC from .env"})...`);
console.log(`Memo: ${buildMemoPayload(batch)}`);

const result = await createSender(config).send(batch, ids, () => 0);
if (result.type === "tx_confirmed") {
  console.log(`Confirmed.`);
  console.log(`Signature: ${result.signature}`);
  console.log(`Explorer:  ${explorerUrl(result.signature)}`);
  console.log(`confirmMs: ${result.confirmMs}`);
} else {
  console.error(`Failed: ${result.error}`);
  process.exitCode = 1;
}
