// Volatone backend: replay engine + transaction worker + WebSocket feed.
//   PORT     WebSocket port (default 8080)
//   CHAIN    "off" = no Solana sending (events still flow, no tx events). Otherwise real devnet sends.
//   TICK_MS  real ms per replay second (default 1000)
// Solana settings (SOLANA_RPC_URL, WALLET_PATH, LOG_VIA) come from the environment or the repo's .env.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { createSender, REPO_ROOT } from "./chain/sender";
import { loadExplanations } from "./agents/explanations";
import { realClock } from "./engine/clock";
import { ReplayEngine } from "./engine/replay";
import { attachServer } from "./engine/server";

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT ?? 8080);
const chainOn = process.env.CHAIN?.trim().toLowerCase() !== "off";
const tickMs = Number(process.env.TICK_MS ?? 1000);
const log = (msg: string) => console.log(`[volatone] ${msg}`);

const explanations = loadExplanations();
const engine = new ReplayEngine({
  clock: realClock,
  tickMs,
  sender: chainOn ? createSender() : null,
  explanations: explanations.texts,
  log,
});

const wss = new WebSocketServer({ port });
attachServer(wss, engine, log);

engine.subscribe((e) => {
  if (e.type === "tx_failed") log(`tx failed (${e.eventIds.length} events): ${e.error}`);
  if (e.type === "reset") log(`reset (speed ${e.speed ?? 1})`);
});

wss.on("listening", () => {
  log(`WebSocket feed on ws://localhost:${port}`);
  log(chainOn ? "CHAIN on: logging to Solana devnet" : "CHAIN=off: no Solana sending, no tx events");
  log(explanations.source);
});
