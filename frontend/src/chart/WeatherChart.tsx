import { CORRIDORS, cycloneRisk, worstState, type State } from "../state";
import { LAND_PATH } from "./land";
import {
  CORRIDOR_HUB_LINKS, CYCLONE, FRONTS, HUBS, INK, STATE_COLOR, STATE_NAME, curvePath, frontMarks, isobars, type HubCode,
} from "./geometry";

const mono = "'IBM Plex Mono', monospace";
const barlow = "'Barlow Condensed', sans-serif";
const serif = "'Instrument Serif', Georgia, serif";

const GRID_X = [161.6, 324.8, 488, 651.2, 814.4, 977.6];
const GRID_Y = [78, 174, 366, 462];

export function WeatherChart({ state }: { state: State }) {
  const risk = cycloneRisk(state);
  const cycState = worstState(state, ["USD-JPY", "EUR-JPY"]);
  const cycColor = STATE_COLOR[cycState];
  const rings = isobars(risk);
  // The low gets tighter and spins faster as risk rises (idle motion, slow). Reduced-motion turns it off in CSS.
  const spin = `${Math.round(60 - 42 * risk)}s`;
  const label = "Synoptic chart. " + CORRIDORS.map((c) => `${c} ${STATE_NAME[state.corridors[c].state].toLowerCase()}, ${Math.round(state.corridors[c].risk * 100)} percent`).join(". ");

  return (
    <svg viewBox="0 0 1000 470" className="chart-svg" role="img" aria-label={label}>
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={INK.cream} strokeWidth="0.9" opacity="0.55" />
        </pattern>
      </defs>
      <rect width="1000" height="470" fill={INK.blue} />
      <g stroke={INK.cream} strokeOpacity="0.14" strokeWidth="0.7">
        {GRID_X.map((x) => <line key={x} x1={x} y1="0" x2={x} y2="470" />)}
        {GRID_Y.map((y) => <line key={y} x1="0" y1={y} x2="1000" y2={y} />)}
      </g>
      <line x1="0" y1="270" x2="1000" y2="270" stroke={INK.cream} strokeOpacity="0.3" strokeWidth="0.8" strokeDasharray="10 5" />
      <g fontFamily={mono} fontSize="11" fill={INK.cream} fillOpacity="0.65">
        <text x="6" y="74">60°N</text><text x="6" y="170">30°N</text><text x="6" y="266">0°</text><text x="6" y="362">30°S</text>
        <text x="324.8" y="464" textAnchor="middle">60°W</text><text x="488" y="464" textAnchor="middle">0°</text>
        <text x="651.2" y="464" textAnchor="middle">60°E</text><text x="814.4" y="464" textAnchor="middle">120°E</text>
      </g>

      <path d={LAND_PATH} fill="url(#hatch)" stroke={INK.cream} strokeWidth="1.3" strokeLinejoin="round" strokeOpacity="0.92" />

      <g fontFamily={serif} fontStyle="italic" fontSize="18" fill={INK.cream} fillOpacity="0.55" textAnchor="middle">
        <text x="379.2" y="225.2">North Atlantic</text><text x="700.2" y="314.8">Indian Ocean</text>
        <text x="80" y="295.6">South Pacific</text><text x="923.2" y="225.2">North Pacific</text>
      </g>

      {/* Low over Tokyo: isobars tighten with risk of USD-JPY / EUR-JPY */}
      <g opacity={(risk * 0.85).toFixed(2)}><circle className="eye" cx={CYCLONE.x} cy={CYCLONE.y} r="11" fill={cycColor} /></g>
      <g className="swirl" style={{ transformOrigin: `${CYCLONE.x}px ${CYCLONE.y}px`, animationDuration: spin }}>
        {rings.map((g, i) => (
          <ellipse key={i} cx={CYCLONE.x} cy={CYCLONE.y} rx={g.rx} ry={g.ry} transform={`rotate(${g.rot} ${CYCLONE.x} ${CYCLONE.y})`}
            fill="none" stroke={INK.cream} strokeWidth={g.w} opacity={g.opacity} style={{ transition: "all .6s ease" }} />
        ))}
      </g>

      {/* Fronts: line pattern + marks + colour all carry the state */}
      {CORRIDORS.map((c) => {
        const { state: st } = state.corridors[c];
        const col = STATE_COLOR[st];
        const { curve } = FRONTS[c];
        return (
          <g key={c}>
            <path d={curvePath(curve)} fill="none" stroke={col} strokeLinecap="round"
              strokeWidth={st === "storm" ? 3.2 : st === "spreading" ? 2.4 : 2.2} strokeDasharray={st === "calm" ? "1.5 7" : undefined} />
            {frontMarks(curve, st).map((m, i) => (
              <path key={i} transform={`translate(${m.x.toFixed(1)} ${m.y.toFixed(1)}) rotate(${m.deg.toFixed(1)})`}
                d={m.tri ? "M-6 0 L0 -10 L6 0 Z" : "M-6 0 A6 6 0 0 1 6 0 Z"} fill={col} />
            ))}
          </g>
        );
      })}

      <g fontFamily={barlow} fontWeight="700" fill={INK.cream}>
        <text x="406.4" y="158" fontSize="30" textAnchor="middle">H</text>
        <text x="705.6" y="84.4" fontSize="30" textAnchor="middle">H</text>
        <text x="880" y="121.8" fontSize="38" fill={cycColor} stroke={INK.blue} strokeWidth="4" paintOrder="stroke">L</text>
      </g>

      {/* Corridor labels: name, risk and state in words */}
      {CORRIDORS.map((c) => {
        const { state: st, risk: r } = state.corridors[c];
        const [px, py] = FRONTS[c].pill;
        return (
          <g key={c}>
            <rect x={px - 58} y={py - 18} width="116" height="36" rx="2" fill={INK.blue} stroke={STATE_COLOR[st]} strokeWidth="1.4" />
            <text x={px} y={py - 5} textAnchor="middle" fontFamily={mono} fontSize="13" fontWeight="500" fill={INK.cream}>{c} {Math.round(r * 100)}%</text>
            <text x={px} y={py + 10} textAnchor="middle" fontFamily={mono} fontSize="12" letterSpacing="1.5" fill={STATE_COLOR[st]}>{STATE_NAME[st]}</text>
          </g>
        );
      })}

      {/* Hubs as wind barbs: more barbs and a bigger dot as risk grows */}
      {(Object.keys(HUBS) as HubCode[]).map((k) => {
        const h = HUBS[k];
        const linked = CORRIDOR_HUB_LINKS[k];
        const r = Math.max(...linked.map((c) => state.corridors[c].risk));
        const worst = worstState(state, linked);
        return (
          <g key={k} transform={`translate(${h.x} ${h.y})`}>
            <g transform={`rotate(${h.barb})`} stroke={INK.cream} strokeWidth="1.4" strokeLinecap="round">
              <line x1="0" y1="-9" x2="0" y2="-34" /><line x1="0" y1="-34" x2="9" y2="-38" />
              <line x1="0" y1="-28" x2="9" y2="-32" opacity={worst === "calm" ? 0 : 0.95} />
              <line x1="0" y1="-22" x2="9" y2="-26" opacity={worst === "storm" ? 0.95 : 0} />
            </g>
            <circle r="9" fill={INK.blue} stroke={INK.cream} strokeWidth="1.6" />
            <circle r={(1.5 + r * 5.5).toFixed(1)} fill={INK.cream} style={{ transition: "r .4s" }} />
            <text x={h.lx} y={h.ly} textAnchor={h.anchor} fontFamily={barlow} fontWeight="700" fontSize="17" letterSpacing="1"
              fill={INK.cream} stroke={INK.blue} strokeWidth="4" paintOrder="stroke" strokeLinejoin="round">{h.code}</text>
            <text x={h.lx} y={h.ly + 13} textAnchor={h.anchor} fontFamily={mono} fontSize="11"
              fill={INK.cream} stroke={INK.blue} strokeWidth="4" paintOrder="stroke" strokeLinejoin="round">{h.city}</text>
          </g>
        );
      })}

      {/* Plates */}
      <rect x="20" y="384" width="236" height="66" fill={INK.blue} stroke={INK.cream} strokeWidth="1.2" />
      <rect x="23" y="387" width="230" height="60" fill="none" stroke={INK.cream} strokeWidth="0.6" />
      <text x="34" y="410" fontFamily={barlow} fontWeight="700" fontSize="22" letterSpacing="2.4" fill={INK.cream}>SURFACE ANALYSIS</text>
      <text x="34" y="426" fontFamily={mono} fontSize="11" fill={INK.cream}>CURRENCY CORRIDORS · T+{String(Math.floor(state.t / 1000)).padStart(3, "0")}</text>
      <text x="34" y="440" fontFamily={mono} fontSize="11" fill={INK.cream} fillOpacity="0.7">SEEDED REPLAY · NOT A FORECAST</text>

      <g>
        <rect x="590" y="392" width="196" height="62" fill={INK.blue} stroke={INK.cream} strokeWidth="1.2" />
        <line x1="602" y1="407" x2="642" y2="407" stroke={INK.cream} strokeWidth="2.2" strokeDasharray="1.5 7" strokeLinecap="round" />
        <line x1="602" y1="424" x2="642" y2="424" stroke={INK.amber} strokeWidth="2.4" />
        <path d="M-6 0 A6 6 0 0 1 6 0 Z" transform="translate(614 424)" fill={INK.amber} /><path d="M-6 0 A6 6 0 0 1 6 0 Z" transform="translate(630 424)" fill={INK.amber} />
        <line x1="602" y1="442" x2="642" y2="442" stroke={INK.vermilion} strokeWidth="3.2" />
        <path d="M-6 0 L0 -10 L6 0 Z" transform="translate(614 442)" fill={INK.vermilion} /><path d="M-6 0 A6 6 0 0 1 6 0 Z" transform="translate(630 442)" fill={INK.vermilion} />
        <g fontFamily={mono} fontSize="12" fill={INK.cream}>
          <text x="654" y="411">CALM</text><text x="654" y="428">SPREADING</text><text x="654" y="446">STORM</text>
        </g>
      </g>
      <rect x="1.5" y="1.5" width="997" height="467" fill="none" stroke={INK.cream} strokeWidth="2" />
    </svg>
  );
}
