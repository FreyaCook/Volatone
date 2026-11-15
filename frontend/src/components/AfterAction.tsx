import type { ReportMessage } from "@volatone/shared/protocol";
import { pct } from "../format";

const AGENT: Record<string, string> = { sentinel: "Sentinel", opportunist: "Opportunist", strategist: "Strategist" };

/** The line under the report says where it came from, or why there is none. Announced politely. */
export function statusLine(report: ReportMessage | null, mock: boolean): string {
  if (mock) return "MOCK: not from Tiger Data.";
  if (!report) return "Reading the report back from Tiger Data…";
  if (report.status === "unavailable") return "Tiger Data unavailable. Replay and Solana log are unaffected.";
  if (report.status === "off") return "Tiger Data switched off.";
  return `Read back from Tiger Data in ${report.queryMs ?? "?"} ms.`;
}

export function AfterAction({ report, mock }: { report: ReportMessage | null; mock: boolean }) {
  const data = report?.status === "ok" ? report : null;
  const sol = data?.solana;
  return (
    <section className="after" aria-label="After-action report">
      <div className="panel-head"><h2>AFTER-ACTION REPORT</h2><span>the replay is complete</span></div>

      {data && (
        <div className="after-grid">
          <div className="slip after-card">
            <h3>PEAK RISK</h3>
            <ul>
              {data.corridors?.map((c) => (
                <li key={c.corridor}>
                  <span>{c.corridor}</span>
                  <span className="bar" aria-hidden="true"><i style={{ width: `${pct(c.peakRisk)}%` }} /></span>
                  <b>{pct(c.peakRisk)}%</b>
                  <small>mean {pct(c.meanRisk)}%</small>
                </li>
              ))}
            </ul>
            <p className="after-note">Agent views logged: {data.agentViews}.</p>
          </div>

          <div className="slip after-card after-moves">
            <h3>YOUR MOVES</h3>
            {data.moves?.length ? (
              <ul>
                {data.moves.map((m, i) => (
                  <li key={i}>
                    <div><b>{m.corridor}</b> · {m.action.toUpperCase()} · {m.result === null ? "outcome pending" : m.result === "good" ? "✓ GOOD" : "✗ POOR"}</div>
                    {m.reason && <div className="after-reason">{m.reason}</div>}
                    <div className="after-views">
                      Agents showed: {m.views.length ? m.views.map((v) => `${AGENT[v.agent] ?? v.agent} ${v.action}`).join(", ") : "nothing yet"}.
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No moves were made: every prompt was missed, so nothing was logged.</p>
            )}
          </div>

          <div className="slip after-card">
            <h3>SOLANA DEVNET LOG</h3>
            {mock ? (
              <p>{sol?.count ?? 0} simulated batches. Mock mode sends nothing to devnet.</p>
            ) : sol && sol.count > 0 ? (
              <>
                <p><b>{sol.count}</b> batches confirmed{sol.failures ? `, ${sol.failures} failed` : ""}.</p>
                <p>Confirm time: {sol.minMs} to {sol.maxMs} ms, mean {sol.meanMs} ms.</p>
              </>
            ) : (
              <p>No confirmed batches{sol?.failures ? ` (${sol.failures} failed)` : ""}.</p>
            )}
            <p className="after-note">Fake money, devnet only.</p>
          </div>
        </div>
      )}

      <p className="after-status" role="status" aria-live="polite">{statusLine(report, mock)}</p>
    </section>
  );
}
