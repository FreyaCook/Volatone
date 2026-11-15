import type { PlayTokens, ReportMessage } from "@volatone/shared/protocol";
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

/** Plain wording for the play tokens (a devnet demo; they have no value). */
export function playTokensLine(t: PlayTokens): string {
  return `${t.minted} play tokens (${t.symbol}) minted, confirmed in ${t.confirmMs} ms.`;
}

export const HONESTY_LINE = "Fake money, devnet only.";
export const HONESTY_LINE_WITH_TOKENS = "Play tokens have no value. Fake money, devnet only.";

type Solana = NonNullable<ReportMessage["solana"]>;

/** One card for everything that happened on Solana devnet: the log batches and, if any, the play tokens. */
function DevnetCard({ sol, mock, tokens }: { sol?: Solana; mock: boolean; tokens?: PlayTokens }) {
  return (
    <div className="slip after-card after-devnet">
      <h3>ON SOLANA DEVNET</h3>
      {mock ? (
        <p>{sol?.count ?? 0} simulated batches. Mock mode sends nothing to devnet.</p>
      ) : sol && sol.count > 0 ? (
        <>
          <p><b>{sol.count}</b> batches confirmed{sol.failures ? `, ${sol.failures} failed` : ""}.</p>
          <p>Confirm time: {sol.minMs} to {sol.maxMs} ms, mean {sol.meanMs} ms.</p>
        </>
      ) : sol ? (
        <p>No confirmed batches{sol.failures ? ` (${sol.failures} failed)` : ""}.</p>
      ) : null}
      {tokens && (
        <>
          <p>{playTokensLine(tokens)}</p>
          <p>
            <a href={`https://explorer.solana.com/tx/${tokens.signature}?cluster=devnet`} target="_blank" rel="noreferrer">
              Transaction on Solana Explorer<span className="sr"> (opens in a new tab)</span>
            </a>
          </p>
        </>
      )}
      <p className="after-note">{tokens ? HONESTY_LINE_WITH_TOKENS : HONESTY_LINE}</p>
    </div>
  );
}

export function AfterAction({ report, mock }: { report: ReportMessage | null; mock: boolean }) {
  const data = report?.status === "ok" ? report : null;
  const tokens = report?.playTokens;
  return (
    <section className="after" aria-label="After-action report">
      <div className="panel-head">
        <h2>AFTER-ACTION REPORT</h2>
        <div className="head-right">
          <span>the replay is complete</span>
          <span className="after-status" role="status" aria-live="polite">{statusLine(report, mock)}</span>
        </div>
      </div>

      {data ? (
        <div className="after-grid">
          <div className="after-left">
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
            <DevnetCard sol={data.solana} mock={mock} tokens={tokens} />
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
        </div>
      ) : (
        tokens && <div className="after-grid after-single"><DevnetCard mock={mock} tokens={tokens} /></div>
      )}
    </section>
  );
}
