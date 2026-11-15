// Creates the devnet play token "Volatone Play" (VPLAY, 0 decimals), once.
//   - Idempotent: if VPLAY_MINT is already set in the loaded environment, it only verifies that the mint
//     exists on devnet and exits. Otherwise it creates the mint (mint authority = the backend wallet) and
//     appends VPLAY_MINT=<address> to the .env file that was loaded (ENV_FILE, or the repo's .env).
//   - The token has no value. It is a devnet demo.
//   - Prints only the mint address, the Explorer link and timings. Never the keypair or the RPC URL.
//
// Run:  ENV_FILE=/path/to/.env npm run make-token -w backend

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import { createMint, getMint } from "@solana/spl-token";
import { configFromEnv, loadKeypair, REPO_ROOT } from "../src/chain/sender";
import { parseMint, VPLAY_DECIMALS } from "../src/token/mint";
import { safeError } from "../src/tiger/queue";

const envFile = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = configFromEnv();
const link = (mint: string) => `https://explorer.solana.com/address/${mint}?cluster=devnet`;
const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;

async function main() {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const existing = process.env.VPLAY_MINT?.trim();

  if (existing) {
    const mint = parseMint(existing);
    if (!mint) throw new Error("VPLAY_MINT is set but is not a valid address. Remove it to create a new mint.");
    const t = performance.now();
    const info = await getMint(connection, mint); // throws if the account is not a mint
    console.log(`VPLAY_MINT is already set. The mint exists on devnet (${ms(t)}).`);
    console.log(`  mint:      ${mint.toBase58()}`);
    console.log(`  decimals:  ${info.decimals}${info.decimals === VPLAY_DECIMALS ? "" : " (expected 0)"}`);
    console.log(`  explorer:  ${link(mint.toBase58())}`);
    console.log("Nothing was created.");
    return;
  }

  const payer = loadKeypair(config.walletPath); // the backend wallet: pays, and is the mint authority
  const t = performance.now();
  const mint = await createMint(connection, payer, payer.publicKey, null, VPLAY_DECIMALS); // no freeze authority
  const address = mint.toBase58();
  console.log(`Created the VPLAY mint on devnet in ${ms(t)}.`);
  console.log(`  mint:      ${address}`);
  console.log(`  explorer:  ${link(address)}`);

  try {
    const needsNewline = existsSync(envFile) && !readFileSync(envFile, "utf8").endsWith("\n");
    appendFileSync(envFile, `${needsNewline ? "\n" : ""}VPLAY_MINT=${address}\n`);
    console.log("Added VPLAY_MINT to the loaded .env file. Restart the backend to use it.");
  } catch {
    console.log(`Could not write the .env file. Add this line to it yourself:  VPLAY_MINT=${address}`);
  }
  console.log("Play tokens have no value. This is a devnet demo.");
}

main().catch((e) => {
  console.error("make-token failed: " + safeError(e, [config.rpcUrl]));
  process.exit(1);
});
