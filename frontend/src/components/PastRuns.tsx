import type { RunsMessage } from "@volatone/shared/protocol";
import { goodCallsText, pastRunsStatus, SPEED_NAME } from "../pastRuns";
import { pct } from "../format";

export function PastRuns({ runs, mock }: { runs: RunsMessage | null; mock: boolean }) {
  const list = runs?.status === "ok" ? runs.runs ?? [] : null;
  return (
    <section className="past" aria-label="Past runs">
      <div className="panel-head"><h2>PAST RUNS</h2><span>last 10 completed runs</span></div>
      {list && list.length > 0 && (
        <ul className="slip past-list">
          {list.map((r) => (
            <li key={r.runId}>
              <span>{new Date(r.finishedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
              <span>{SPEED_NAME[r.speed] ?? `${r.speed}x`}</span>
              <span>{goodCallsText(r.goodCalls, r.moves)}</span>
              <span>peak {pct(r.peakRisk)}%</span>
              <span>{r.confirmedBatches} Solana batches confirmed</span>
            </li>
          ))}
        </ul>
      )}
      {list && list.length === 0 && <p className="slip past-empty">No completed runs recorded yet.</p>}
      <p className="after-status" role="status" aria-live="polite">{pastRunsStatus(runs, mock)}</p>
    </section>
  );
}
