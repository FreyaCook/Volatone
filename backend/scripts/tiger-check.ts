// Checks the Tiger Data connection end to end and cleans up after itself.
//   - connects, creates the schema, inserts one row into each table, reads them back,
//     builds a report from them, prints timings and which aggregate type is in use,
//     then deletes its own test rows.
//   - Prints no connection string, host or password: only timings, counts and names of steps.
//
// Run:  ENV_FILE=/path/to/.env npm run tiger-check -w backend

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "../src/chain/sender";
import { createPool } from "../src/tiger/config";
import { safeError } from "../src/tiger/queue";
import { queryReport } from "../src/tiger/report";
import { ensureSchema } from "../src/tiger/schema";
import { insertRows } from "../src/tiger/writer";

const envFile = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.TIGER_DATABASE_URL?.trim();
if (!url) {
  console.error("TIGER_DATABASE_URL not found (looked in the environment and " + (existsSync(envFile) ? "the env file" : "no env file") + ").");
  process.exit(1);
}

const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const pool = createPool(url, () => {});
const runId = randomUUID();
let exit = 0;

try {
  let t = performance.now();
  await pool.query("SELECT 1");
  console.log(`connect + SELECT 1: ${ms(t)}`);

  t = performance.now();
  const info = await ensureSchema(pool, (m) => console.log("  " + m));
  console.log(`schema: ${ms(t)}. risk_10s is a ${info.aggregate === "continuous" ? "CONTINUOUS AGGREGATE" : info.aggregate === "view" ? "plain VIEW (fallback)" : "MISSING"}; compression ${info.compression ? "enabled" : "not enabled"}; steps that failed: ${info.failed.length ? info.failed.join(", ") : "none"}`);

  const now = new Date().toISOString();
  t = performance.now();
  await insertRows(pool, [
    { table: "runs", run_id: runId, scenario: "tiger-check", seed: null, speed: 1, started_at: now },
    { table: "risk_ticks", ts: now, run_id: runId, corridor: "USD-JPY", replay_t: 1000, risk: 0.5, state: "spreading" },
    { table: "events", ts: now, run_id: runId, replay_t: 1000, kind: "agent_view", actor: "sentinel", corridor: "USD-JPY", action: "hedge", detail: JSON.stringify({ id: "chk_1", risk: 0.5, explanation: "check" }) },
    { table: "events", ts: now, run_id: runId, replay_t: 2000, kind: "player_move", actor: "player", corridor: "USD-JPY", action: "hedge", detail: JSON.stringify({ id: "chk_2" }) },
    { table: "events", ts: now, run_id: runId, replay_t: 17000, kind: "outcome", actor: "player", corridor: "USD-JPY", action: "hedge", detail: JSON.stringify({ moveId: "chk_2", result: "good", reason: "check" }) },
    { table: "tx_log", ts: now, run_id: runId, replay_t: 2500, signature: "tiger-check", events: 2, confirm_ms: 1000, ok: true },
  ]);
  console.log(`inserted 1 row (3 for events) into each table: ${ms(t)}`);

  for (const table of ["runs", "risk_ticks", "events", "tx_log"]) {
    t = performance.now();
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [runId]);
    console.log(`read back ${table}: ${r.rows[0].n} row(s), ${ms(t)}`);
  }

  if (info.aggregate !== "none") {
    const report = await queryReport(pool, runId, info.aggregate);
    const c = report.corridors?.[0];
    console.log(`report: status ${report.status}, queries took ${report.queryMs} ms, peak risk seen via risk_10s: ${c ? c.peakRisk : "none"}, moves ${report.moves?.length}, with outcome "${report.moves?.[0]?.result}", agent views at the move: ${report.moves?.[0]?.views.length}`);
  }
} catch (e) {
  console.error("tiger-check failed: " + safeError(e, [url]));
  exit = 1;
} finally {
  try {
    for (const table of ["risk_ticks", "events", "tx_log", "runs"]) await pool.query(`DELETE FROM ${table} WHERE run_id = $1`, [runId]);
    console.log("deleted this check's own test rows");
  } catch (e) {
    console.error("cleanup failed: " + safeError(e, [url]));
    exit = 1;
  }
  await pool.end().catch(() => {});
}
process.exit(exit);
