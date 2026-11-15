// Mock mode only: builds the same shape as the server's after-action report from the local mock state.
// (With the real backend the report comes from Tiger Data and is never built in the browser.)
import type { AgentName, Corridor } from "@volatone/shared";
import type { ReportMessage } from "@volatone/shared/protocol";
import { CORRIDORS, type State } from "./state";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function reportFromState(s: State): ReportMessage {
  const corridors = CORRIDORS.flatMap((c: Corridor) => {
    const series = s.corridorSeries[c].filter((v) => v !== undefined);
    if (!series.length) return [];
    return [{ corridor: c, peakRisk: round3(Math.max(...series)), meanRisk: round3(series.reduce((a, b) => a + b, 0) / series.length) }];
  });

  const moves = s.moves.map((m) => {
    // each agent's latest view of that corridor at or before the move (decisions are newest first)
    const seen = new Set<AgentName>();
    const views: { agent: AgentName; action: typeof m.action; risk: number }[] = [];
    for (const d of s.decisions) {
      if (d.corridor !== m.corridor || d.t > m.t || seen.has(d.agent)) continue;
      seen.add(d.agent);
      views.push({ agent: d.agent, action: d.action, risk: d.risk });
    }
    const o = s.outcomes[m.id];
    return { corridor: m.corridor, action: m.action, replayT: m.t, result: o?.result ?? null, reason: o?.reason ?? null, views };
  });

  const ok = s.txs.filter((x) => x.type === "tx_confirmed");
  const ms = ok.map((x) => (x.type === "tx_confirmed" ? x.confirmMs : 0));
  return {
    type: "report",
    status: "ok",
    corridors,
    agentViews: s.decisions.length,
    moves,
    solana: {
      count: ok.length,
      minMs: ms.length ? Math.min(...ms) : null,
      meanMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
      maxMs: ms.length ? Math.max(...ms) : null,
      failures: s.txs.length - ok.length,
    },
  };
}
