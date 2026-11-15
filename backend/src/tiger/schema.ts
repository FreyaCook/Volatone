// Idempotent schema. Each statement has its own try/catch, so a missing TimescaleDB feature
// (for example no continuous aggregates on this plan) never stops the rest.
import type pg from "pg";

export interface SchemaInfo {
  aggregate: "continuous" | "view" | "none"; // what risk_10s is
  compression: boolean;
  failed: string[]; // names of steps that failed (no details, no secrets)
}

const RISK_10S_SELECT = `
  SELECT time_bucket('10 seconds', ts) AS bucket, run_id, corridor,
         max(risk) AS peak_risk, avg(risk) AS mean_risk, count(*) AS n
  FROM risk_ticks GROUP BY time_bucket('10 seconds', ts), run_id, corridor`;

const TABLES: [string, string][] = [
  ["runs", `CREATE TABLE IF NOT EXISTS runs (run_id uuid PRIMARY KEY, scenario text, seed int, speed int, started_at timestamptz)`],
  ["risk_ticks", `CREATE TABLE IF NOT EXISTS risk_ticks (ts timestamptz NOT NULL, run_id uuid, corridor text, replay_t int, risk double precision, state text)`],
  ["events", `CREATE TABLE IF NOT EXISTS events (ts timestamptz NOT NULL, run_id uuid, replay_t int, kind text, actor text, corridor text, action text, detail jsonb)`],
  ["tx_log", `CREATE TABLE IF NOT EXISTS tx_log (ts timestamptz NOT NULL, run_id uuid, replay_t int, signature text, events int, confirm_ms int, ok boolean)`],
];

export async function ensureSchema(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<SchemaInfo> {
  const info: SchemaInfo = { aggregate: "none", compression: false, failed: [] };
  const attempt = async (name: string, sql: string): Promise<boolean> => {
    try {
      await pool.query(sql);
      return true;
    } catch (e) {
      info.failed.push(name);
      log(`schema step "${name}" failed: ${(e as { code?: string }).code ?? "error"}`);
      return false;
    }
  };

  // A connection failure on the very first statement is not a missing feature: let it surface.
  await pool.query("SELECT 1");

  await attempt("extension", "CREATE EXTENSION IF NOT EXISTS timescaledb");
  for (const [name, sql] of TABLES) await attempt(name, sql);
  for (const t of ["risk_ticks", "events", "tx_log"]) {
    await attempt(`hypertable ${t}`, `SELECT create_hypertable('${t}', 'ts', if_not_exists => TRUE)`);
  }

  // Continuous aggregate with real-time aggregation; otherwise a plain view with the same name and columns.
  const cagg = await attempt("risk_10s continuous", `
    CREATE MATERIALIZED VIEW IF NOT EXISTS risk_10s
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS ${RISK_10S_SELECT}
    WITH NO DATA`);
  if (cagg) {
    await attempt("risk_10s policy", `SELECT add_continuous_aggregate_policy('risk_10s',
      start_offset => INTERVAL '1 day', end_offset => INTERVAL '10 seconds',
      schedule_interval => INTERVAL '30 seconds', if_not_exists => TRUE)`);
  } else {
    await attempt("risk_10s view", `CREATE OR REPLACE VIEW risk_10s AS ${RISK_10S_SELECT}`);
  }
  try {
    const r = await pool.query(`SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'risk_10s'`);
    info.aggregate = r.rowCount ? "continuous" : "view";
  } catch {
    // No catalogue (plain Postgres): it is a view if the view exists at all.
    try { await pool.query("SELECT 1 FROM risk_10s LIMIT 1"); info.aggregate = "view"; } catch { info.aggregate = "none"; }
  }

  // Compression is a nice-to-have. Not measured here, so nothing claims a ratio.
  const c1 = await attempt("compression", `ALTER TABLE risk_ticks SET (timescaledb.compress, timescaledb.compress_segmentby = 'run_id, corridor')`);
  if (c1) info.compression = await attempt("compression policy", `SELECT add_compression_policy('risk_ticks', INTERVAL '1 day', if_not_exists => TRUE)`);
  return info;
}
