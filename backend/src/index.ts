// Volatone backend: replay engine + transaction worker + WebSocket feed.
//   PORT     WebSocket port (default 8080)
//   CHAIN    "off" = no Solana sending (events still flow, no tx events). Otherwise real devnet sends.
//   TICK_MS  real ms per replay second (default 1000)
//   TIGER    "off" = no Tiger Data. Default: on only if TIGER_DATABASE_URL is set. The replay and the
//            Solana sender never wait for it (see src/tiger/).
//   MONGODB  "off" = no MongoDB. Default: on only if MONGODB_URI is set. One document per completed run is
//            written once, in the background, after the replay finishes (see src/mongo/).
//   ENV_FILE path of a .env to load instead of the repo's (values already in the environment win)
// Solana settings (SOLANA_RPC_URL, WALLET_PATH, LOG_VIA) come from the environment or the repo's .env.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createSender, REPO_ROOT } from "./chain/sender";
import { loadExplanations } from "./agents/explanations";
import { realClock } from "./engine/clock";
import { ReplayEngine } from "./engine/replay";
import { attachServer } from "./engine/server";
import { createTiger, offReport } from "./tiger";
import { createMongo, offRuns, RunCollector } from "./mongo";
import type { RunDoc } from "./mongo/collector";

const envFile = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(REPO_ROOT, ".env");
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

// Tiger Data: a background time-series store and the after-action report. Never on the replay's path.
const tiger = createTiger(process.env, { scenario: engine.storm.data.name, seed: engine.storm.data.seed, speed: () => engine.speed }, log);
if (tiger) engine.subscribe(tiger.onEvent);
const getReport = async () => (tiger ? tiger.report() : offReport());

// MongoDB: one document per completed run, written once after the replay finishes. Never on the replay's path.
const mongo = createMongo(process.env, log);
const collector = new RunCollector({
  scenario: engine.storm.data.name, seed: engine.storm.data.seed, speed: () => engine.speed, lastSecond: engine.lastSecond,
  sharedRunId: () => tiger?.runId() ?? null, // the same run id as Tiger Data when both are on
});
if (mongo) engine.subscribe((e) => { try { collector.onEvent(e); } catch { /* never break the feed */ } });
const getRuns = async () => (mongo ? mongo.recentRuns() : offRuns());

const wss = new WebSocketServer({ port });
attachServer(wss, engine, log, getReport, getRuns);
const broadcast = (msg: object) => {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
};
const pushRuns = () => void getRuns().then(broadcast);

// A few seconds after the replay finishes (so the last Solana batch can land), push the report to everyone.
const REPORT_SETTLE_MS = 5000;
let reportTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDoc: RunDoc | null = null; // the finished run's record, kept in memory until it is written
/** Write the finished run once, in the background, then send everyone the recent-runs list. */
const saveRun = (doc: RunDoc) => {
  if (!mongo) return pushRuns(); // tells clients "MongoDB switched off"
  void mongo.saveRun(doc, pushRuns).then(pushRuns);
};
engine.subscribe((e) => {
  if (e.type === "reset") {
    clearTimeout(reportTimer);
    // A reset inside the settle window: write the run as it stood when it finished.
    if (pendingDoc) { saveRun(pendingDoc); pendingDoc = null; }
  }
  if (e.type === "tick" && e.t >= engine.lastSecond * 1000 && e.corridor === "GBP-USD") {
    clearTimeout(reportTimer);
    if (mongo) pendingDoc = collector.build();
    reportTimer = setTimeout(() => {
      if (pendingDoc) { saveRun(collector.runId === pendingDoc.runId ? collector.build() : pendingDoc); pendingDoc = null; }
      else if (!mongo) pushRuns();
      void getReport().then((r) => {
        broadcast(r);
        log(`report sent (${r.status}${r.queryMs !== undefined ? `, ${r.queryMs} ms` : ""})${tiger ? ` tiger ${JSON.stringify(tiger.status())}` : ""}${mongo ? ` mongo saved=${mongo.saved} dropped=${mongo.dropped}` : ""}`);
      });
    }, REPORT_SETTLE_MS);
  }
});

engine.subscribe((e) => {
  if (e.type === "tx_failed") log(`tx failed (${e.eventIds.length} events): ${e.error}`);
  if (e.type === "reset") log(`reset (speed ${e.speed ?? 1})`);
});

wss.on("listening", () => {
  log(`WebSocket feed on ws://localhost:${port}`);
  log(chainOn ? "CHAIN on: logging to Solana devnet" : "CHAIN=off: no Solana sending, no tx events");
  log(explanations.source);
  log(tiger ? "TIGER on: writing the replay to Tiger Data in the background" : "TIGER off: no Tiger Data");
  log(mongo ? "MONGODB on: one record per completed run, written in the background" : "MONGODB off: no MongoDB");
});
