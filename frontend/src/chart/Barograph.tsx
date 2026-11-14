import { useMemo } from "react";
import { DECISION_POINTS, REPLAY_LAST_SECOND } from "@volatone/shared/protocol";
import type { State } from "../state";

const mono = "'IBM Plex Mono', monospace";
const x = (s: number) => 30 + (s * 930) / REPLAY_LAST_SECOND;
const y = (v: number) => 98 - v * 76; // v = 0..1

/** Red pen trace of the storm index, drawn from the ticks received so far. */
export function Barograph({ state }: { state: State }) {
  const trace = useMemo(() => {
    const pts = state.indexSeries.map((v, s) => [s, v] as const).filter(([, v]) => v !== undefined);
    return pts.map(([s, v], i) => `${i ? "L" : "M"}${x(s).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  }, [state.indexSeries]);
  const sec = Math.min(Math.floor(state.t / 1000), REPLAY_LAST_SECOND);
  const now = state.indexSeries[sec];

  return (
    <div className="barograph">
      <svg viewBox="0 0 1000 120" role="img" aria-label="Barograph: the storm index over the 150 second replay, with four decision points D1 to D4">
        <defs>
          <pattern id="bgrid" width="20" height="19" patternUnits="userSpaceOnUse">
            <path d="M20 0 L0 0 L0 19" fill="none" stroke="#7a5a2e" strokeWidth="0.6" opacity="0.4" />
          </pattern>
        </defs>
        <rect x="30" y="22" width="930" height="76" fill="url(#bgrid)" stroke="#7a5a2e" strokeWidth="0.8" strokeOpacity="0.6" />
        <text x="30" y="14" fontFamily={mono} fontSize="12" fill="#1a1a18" letterSpacing="1.5">BAROGRAPH · STORM INDEX %</text>
        <text x="960" y="14" textAnchor="end" fontFamily={mono} fontSize="12" fill="#1a1a18">D = decision point</text>
        <g fontFamily={mono} fontSize="12" fill="#1a1a18" textAnchor="middle">
          {[0, 30, 60, 90, 120, 150].map((s) => <text key={s} x={x(s)} y="113">{s === 0 ? "0 s" : s === 150 ? "150 s" : s}</text>)}
        </g>
        {DECISION_POINTS.map((p, i) => (
          <g key={p.id} transform={`translate(${x(p.second).toFixed(1)} 20)`}>
            <path d="M-5 0 L5 0 L0 8 Z" fill="#13294b" />
            <line x1="0" y1="8" x2="0" y2="78" stroke="#13294b" strokeWidth="0.8" strokeDasharray="3 3" />
            <text x="9" y="9" fontFamily={mono} fontSize="12" fill="#13294b">D{i + 1}</text>
          </g>
        ))}
        <path d={trace} fill="none" stroke="#b8290f" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {now !== undefined && (
          <>
            <line x1={x(sec)} y1="18" x2={x(sec)} y2="100" stroke="#1a1a18" strokeWidth="1" />
            <circle cx={x(sec)} cy={y(now)} r="4.5" fill="#b8290f" stroke="#1a1a18" strokeWidth="1" />
          </>
        )}
      </svg>
    </div>
  );
}
