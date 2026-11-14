import { geoEquirectangular, geoGraticule10, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import type { Corridor } from "@volatone/shared";
import { CORRIDORS, type State } from "../state";
import { STATE_ICON, STATE_LABEL } from "../theme";

const W = 960;
const projection = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, 0]);
const TOP = projection([0, 78])![1];
const BOTTOM = projection([0, -56])![1];
const H = BOTTOM - TOP;
projection.translate([W / 2, -TOP]);

const path = geoPath(projection);
const topo = land110 as unknown as Topology;
const LAND = path(feature(topo, topo.objects.land as never) as never) ?? "";
const GRATICULE = path(geoGraticule10()) ?? "";

type Pt = [number, number];
const HUBS: Record<string, { name: string; ll: Pt; dx: number; dy: number; anchor: "start" | "end" | "middle" }> = {
  USD: { name: "New York · USD", ll: [-74, 40.7], dx: -8, dy: 16, anchor: "end" },
  GBP: { name: "London · GBP", ll: [-0.1, 51.5], dx: -8, dy: -8, anchor: "end" },
  EUR: { name: "Frankfurt · EUR", ll: [8.7, 50.1], dx: 10, dy: -8, anchor: "start" },
  JPY: { name: "Tokyo · JPY", ll: [139.7, 35.7], dx: 0, dy: 20, anchor: "middle" },
};

// bend: how far the arc curves, as a fraction of its length (negative = curves downward on screen)
// wrap: draw across the Pacific edge instead of across the whole map
const ARCS: Record<Corridor, { from: string; to: string; bend: number; wrap?: boolean }> = {
  "USD-JPY": { from: "USD", to: "JPY", bend: 0.18, wrap: true },
  "EUR-JPY": { from: "EUR", to: "JPY", bend: 0.3 },
  "EUR-USD": { from: "USD", to: "EUR", bend: -0.2 },
  "GBP-USD": { from: "USD", to: "GBP", bend: 0.28 },
};

const pt = (k: string): Pt => projection(HUBS[k].ll) as Pt;

function arc(a: Pt, b: Pt, bend: number) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const c: Pt = [mx + dy * bend * -1, my + dx * bend]; // perpendicular to the chord
  const mid: Pt = [0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1]];
  return { d: `M${a[0]},${a[1]} Q${c[0]},${c[1]} ${b[0]},${b[1]}`, mid };
}

function shape(c: Corridor) {
  const { from, to, bend, wrap } = ARCS[c];
  const a = pt(from), b = pt(to);
  // Pacific wrap: draw the arc twice, to a copy of the target one map-width to the left, and from a copy
  // of the source one map-width to the right. The viewBox clips each copy at the map edge.
  if (wrap) {
    const first = arc(a, [b[0] - W, b[1]], bend);
    const second = arc([a[0] + W, a[1]], b, bend);
    return { ds: [first.d, second.d], mid: first.mid };
  }
  const one = arc(a, b, bend);
  return { ds: [one.d], mid: one.mid };
}
const SHAPES = Object.fromEntries(CORRIDORS.map((c) => [c, shape(c)])) as Record<Corridor, ReturnType<typeof shape>>;

export function WorldMap({ state }: { state: State }) {
  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="World map with four currency corridors and their storm state">
      <path d={GRATICULE} className="graticule" />
      <path d={LAND} className="land" />
      {CORRIDORS.map((c) => {
        const { state: st, risk } = state.corridors[c];
        const { ds, mid } = SHAPES[c];
        return (
          <g key={c} className={`corridor st-${st}`}>
            {ds.map((d, i) => <path key={`g${i}`} d={d} className="arc-glow" />)}
            {ds.map((d, i) => <path key={i} d={d} className="arc" />)}
            <g transform={`translate(${mid[0]},${mid[1]})`} className="pill">
              <rect x={-52} y={-19} width={104} height={38} rx={8} />
              <text y={-3} textAnchor="middle" className="pill-top">{c} · {Math.round(risk * 100)}%</text>
              <text y={12} textAnchor="middle" className="pill-state">{STATE_ICON[st]} {STATE_LABEL[st].toUpperCase()}</text>
            </g>
          </g>
        );
      })}
      {Object.entries(HUBS).map(([k, h]) => {
        const [x, y] = pt(k);
        return (
          <g key={k}>
            <circle cx={x} cy={y} r={4} className="hub" />
            <text x={x + h.dx} y={y + h.dy} textAnchor={h.anchor} className="hub-label">{h.name}</text>
          </g>
        );
      })}
    </svg>
  );
}
