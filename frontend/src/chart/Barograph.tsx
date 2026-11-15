import { useMemo } from "react";
import { DECISION_POINTS, REPLAY_LAST_SECOND } from "@volatone/shared/protocol";
import { CORRIDORS, type State } from "../state";

const mono = "'IBM Plex Mono', monospace";
const INK = "#1a1a18";
// Drawn at its own height (not stretched): plot area x 48..960, y TOP..BOTTOM.
const W = 1000, H = 400, LEFT = 48, RIGHT = 960, TOP = 36, BOTTOM = 354;
const x = (s: number) => LEFT + (s * (RIGHT - LEFT)) / REPLAY_LAST_SECOND;
const y = (v: number) => BOTTOM - v * (BOTTOM - TOP); // v = 0..1

/** One dash pattern per corridor, so the thin traces are told apart without colour. */
const DASH: Record<string, string> = { "USD-JPY": "none", "EUR-JPY": "7 3", "EUR-USD": "2 3", "GBP-USD": "10 3 2 3" };

const pathOf = (series: number[]) => {
  let d = "";
  series.forEach((v, s) => { if (v !== undefined) d += `${d ? "L" : "M"}${x(s).toFixed(1)} ${y(v).toFixed(1)}`; });
  return d;
};

/** Paper strip: the storm index as a red pen trace, plus a thin trace per corridor, drawn from the ticks so far. */
export function Barograph({ state }: { state: State }) {
  const trace = useMemo(() => pathOf(state.indexSeries), [state.indexSeries]);
  const thin = useMemo(() => CORRIDORS.map((c) => [c, pathOf(state.corridorSeries[c])] as const), [state.corridorSeries]);
  const sec = Math.min(Math.floor(state.t / 1000), REPLAY_LAST_SECOND);
  const now = state.indexSeries[sec];

  return (
    <div className="barograph">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Barograph: the storm index and each corridor's risk over the 150 second replay, with four decision points D1 to D4">
        <defs>
          <pattern id="bgrid" width="20" height="19" patternUnits="userSpaceOnUse">
            <path d="M20 0 L0 0 L0 19" fill="none" stroke="#7a5a2e" strokeWidth="0.6" opacity="0.4" />
          </pattern>
        </defs>
        <rect x={LEFT} y={TOP} width={RIGHT - LEFT} height={BOTTOM - TOP} fill="url(#bgrid)" stroke="#7a5a2e" strokeWidth="0.8" strokeOpacity="0.6" />
        <text x={LEFT} y="16" fontFamily={mono} fontSize="13" fill={INK} letterSpacing="1.5">BAROGRAPH · RISK %</text>
        <text x={RIGHT} y="16" textAnchor="end" fontFamily={mono} fontSize="13" fill={INK}>D = decision point</text>

        {/* y axis */}
        <g fontFamily={mono} fontSize="12" fill={INK} textAnchor="end">
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={RIGHT} y1={y(v / 100)} y2={y(v / 100)} stroke="#7a5a2e" strokeWidth="0.7" strokeDasharray={v === 0 ? undefined : "2 5"} opacity="0.55" />
              <text x={LEFT - 8} y={y(v / 100) + 4}>{v}</text>
            </g>
          ))}
        </g>
        {/* x axis */}
        <g fontFamily={mono} fontSize="12" fill={INK} textAnchor="middle">
          {[0, 30, 60, 90, 120, 150].map((s) => <text key={s} x={x(s)} y={BOTTOM + 20}>{s === 0 ? "0 s" : s === 150 ? "150 s" : s}</text>)}
        </g>

        {DECISION_POINTS.map((p, i) => (
          <g key={p.id} transform={`translate(${x(p.second).toFixed(1)} ${TOP - 2})`}>
            <path d="M-5 0 L5 0 L0 8 Z" fill="#13294b" />
            <line x1="0" y1="8" x2="0" y2={BOTTOM - TOP + 2} stroke="#13294b" strokeWidth="0.8" strokeDasharray="3 3" />
            <text x="9" y="9" fontFamily={mono} fontSize="12" fill="#13294b">D{i + 1}</text>
          </g>
        ))}

        {thin.map(([c, d]) => (
          <path key={c} d={d} fill="none" stroke="#13294b" strokeWidth="1.2" strokeOpacity="0.7" strokeDasharray={DASH[c]} strokeLinejoin="round" />
        ))}
        <path d={trace} fill="none" stroke="#b8290f" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        {now !== undefined && (
          <>
            <line x1={x(sec)} y1={TOP - 4} x2={x(sec)} y2={BOTTOM + 2} stroke={INK} strokeWidth="1" />
            <circle cx={x(sec)} cy={y(now)} r="4.5" fill="#b8290f" stroke={INK} strokeWidth="1" />
          </>
        )}

        {/* legend */}
        <g fontFamily={mono} fontSize="12" fill={INK}>
          <line x1={LEFT} x2={LEFT + 30} y1={H - 9} y2={H - 9} stroke="#b8290f" strokeWidth="2.6" /><text x={LEFT + 36} y={H - 5}>STORM INDEX</text>
          {CORRIDORS.map((c, i) => (
            <g key={c} transform={`translate(${LEFT + 170 + i * 150} 0)`}>
              <line x1="0" x2="30" y1={H - 9} y2={H - 9} stroke="#13294b" strokeWidth="1.4" strokeDasharray={DASH[c]} />
              <text x="36" y={H - 5}>{c.replace("-", "/")}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
