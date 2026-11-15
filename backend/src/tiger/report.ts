// After-action report, read back from Tiger Data only. The shaping is pure (tested); the queries are not.
import type pg from "pg";
import type { Action, AgentName, Corridor, Outcome } from "@volatone/shared";
import type { ReportMessage, ReportMove } from "@volatone/shared/protocol";

export interface RawReport {
  peaks: { corridor: string; peak: number; mean: number }[];
  agentViews: number;
  moves: { replay_t: number; corridor: string; action: string; result: string | null; reason: string | null;
           views: { agent: string; action: string; risk: number }[] | null }[];
  tx: { n: number; min: number | null; mean: number | null; max: number | null; failures: number };
}

const CORRIDOR_ORDER: Corridor[] = ["USD-JPY", "EUR-JPY", "EUR-USD", "GBP-USD"];
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));

/** Pure: raw rows in, the ReportMessage out. */
export function shapeReport(raw: RawReport, runId: string, queryMs: number, aggregate: "continuous" | "view"): ReportMessage {
  const corridors = CORRIDOR_ORDER.flatMap((c) => {
    const p = raw.peaks.find((x) => x.corridor === c);
    return p ? [{ corridor: c, peakRisk: round3(Number(p.peak)), meanRisk: round3(Number(p.mean)) }] : [];
  });
  const moves: ReportMove[] = raw.moves.map((m) => ({
    corridor: m.corridor as Corridor,
    action: m.action as Action,
    replayT: Number(m.replay_t),
    result: (m.result as Outcome | null) ?? null,
    reason: m.reason ?? null,
    views: (m.views ?? []).map((v) => ({ agent: v.agent as AgentName, action: v.action as Action, risk: round3(Number(v.risk)) })),
  }));
  const ok = Number(raw.tx.n);
  return {
    type: "report", status: "ok", runId, queryMs: Math.round(queryMs), aggregate, corridors,
    agentViews: Number(raw.agentViews), moves,
    solana: { count: ok, minMs: num(raw.tx.min), meanMs: raw.tx.mean === null ? null : Math.round(Number(raw.tx.mean)), maxMs: num(raw.tx.max), failures: Number(raw.tx.failures) },
  };
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export const unavailableReport = (): ReportMessage => ({ type: "report", status: "unavailable" });
export const offReport = (): ReportMessage => ({ type: "report", status: "off" });

/** Runs the four report queries in parallel and shapes the result. Throws if any query fails. */
export async function queryReport(pool: pg.Pool, runId: string, aggregate: "continuous" | "view"): Promise<ReportMessage> {
  const t0 = performance.now();
  const [peaks, views, moves, tx] = await Promise.all([
    pool.query(`SELECT corridor, max(peak_risk) AS peak, sum(mean_risk * n) / sum(n) AS mean
                FROM risk_10s WHERE run_id = $1 GROUP BY corridor`, [runId]),
    pool.query(`SELECT count(*) AS n FROM events WHERE run_id = $1 AND kind = 'agent_view'`, [runId]),
    pool.query(`SELECT m.replay_t, m.corridor, m.action, o.detail->>'result' AS result, o.detail->>'reason' AS reason,
        (SELECT json_agg(json_build_object('agent', v.actor, 'action', v.action, 'risk', (v.detail->>'risk')::float8))
           FROM (SELECT DISTINCT ON (e.actor) e.actor, e.action, e.detail FROM events e
                 WHERE e.run_id = m.run_id AND e.kind = 'agent_view' AND e.corridor = m.corridor AND e.replay_t <= m.replay_t
                 ORDER BY e.actor, e.replay_t DESC, e.ts DESC) v) AS views
      FROM events m
      LEFT JOIN events o ON o.run_id = m.run_id AND o.kind = 'outcome' AND o.detail->>'moveId' = m.detail->>'id'
      WHERE m.run_id = $1 AND m.kind = 'player_move' ORDER BY m.replay_t`, [runId]),
    pool.query(`SELECT count(*) FILTER (WHERE ok) AS n, min(confirm_ms) FILTER (WHERE ok) AS min,
                       avg(confirm_ms) FILTER (WHERE ok) AS mean, max(confirm_ms) FILTER (WHERE ok) AS max,
                       count(*) FILTER (WHERE NOT ok) AS failures FROM tx_log WHERE run_id = $1`, [runId]),
  ]);
  const raw: RawReport = {
    peaks: peaks.rows,
    agentViews: Number(views.rows[0]?.n ?? 0),
    moves: moves.rows,
    tx: tx.rows[0] ?? { n: 0, min: null, mean: null, max: null, failures: 0 },
  };
  return shapeReport(raw, runId, performance.now() - t0, aggregate);
}
