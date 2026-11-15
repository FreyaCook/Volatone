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

export const SOLANA_INTRO = "Everything you did in this run was written to a public record on Solana's practice network, so anyone can check it afterwards.";
export const HONESTY_LINE = "Fake money. Devnet is Solana's practice network.";
export const STEPS = ["You make a call", "It is bundled into a record", "Solana saves it", "Anyone can look it up"] as const;

/** The big line: how many of the records (batches) were saved. Honest when some failed. */
export function recordsLine(sol: { count: number; failures: number } | undefined): string | null {
  if (!sol) return null;
  const total = sol.count + sol.failures;
  return total === 0 ? "No records saved" : `${sol.count} of ${total} records saved`;
}

/** Beside the play-token badge: what the tokens are, with the number of good calls. */
export function tokenLine(goodCalls: number): string {
  return `Play tokens for your ${goodCalls} good ${goodCalls === 1 ? "call" : "calls"}. A public score marker on Solana's practice network, with no value.`;
}

type Solana = NonNullable<ReportMessage["solana"]>;

/** One card for what happened on Solana devnet, for ordinary players: no timings. */
export function DevnetCard({ sol, mock, tokens, goodCalls }: { sol?: Solana; mock: boolean; tokens?: PlayTokens; goodCalls: number }) {
  const records = recordsLine(sol);
  return (
    <div className="slip after-card after-devnet">
      <h3>On Solana devnet</h3>
      <p>{SOLANA_INTRO}</p>
      <ol className="steps">
        {STEPS.map((t, i) => (
          <li key={t}><b className="step-n">{i + 1}</b> {t}</li>
        ))}
      </ol>
      {records && <p className="after-big">{records}</p>}
      {mock && <p><span className="sim">SIMULATED</span> Mock mode sends nothing to devnet.</p>}
      {tokens && (
        <div className="token-row">
          <span className="token-badge">{tokens.minted} {tokens.symbol}</span>
          <p>{tokenLine(goodCalls)}</p>
        </div>
      )}
      {tokens && (
        <p>
          <a href={`https://explorer.solana.com/tx/${tokens.signature}?cluster=devnet`} target="_blank" rel="noreferrer">
            Transaction on Solana Explorer<span className="sr"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      <p className="after-note">{HONESTY_LINE}</p>
    </div>
  );
}

export function AfterAction({ report, mock }: { report: ReportMessage | null; mock: boolean }) {
  const data = report?.status === "ok" ? report : null;
  const tokens = report?.playTokens;
  // Good calls: counted from the moves in the report; without them, 100 tokens were minted per good call.
  const goodCalls = data?.moves ? data.moves.filter((m) => m.result === "good").length : tokens ? Math.round(tokens.minted / 100) : 0;
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
          <div className="slip after-card after-peak">
            <h3>PEAK RISK</h3>
            <p className="card-sub">How risky each currency pair got during the storm.</p>
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
            <p className="card-sub">What you chose, and how it turned out.</p>
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

          <DevnetCard sol={data.solana} mock={mock} tokens={tokens} goodCalls={goodCalls} />
        </div>
      ) : (
        tokens && <div className="after-grid after-single"><DevnetCard mock={mock} tokens={tokens} goodCalls={goodCalls} /></div>
      )}
    </section>
  );
}
