// Fixed geometry from design-reference/volatone-map.svg (viewBox 0 0 1000 470).
import type { Corridor, StormState } from "@volatone/shared";

export type Curve = [x0: number, y0: number, cx: number, cy: number, x1: number, y1: number];

export const HUBS = {
  USD: { x: 286.72, y: 139.76, code: "USD", city: "NEW YORK", lx: 12, ly: 16, anchor: "start", barb: -40 },
  GBP: { x: 487.73, y: 105.2, code: "GBP", city: "LONDON", lx: -12, ly: -24, anchor: "end", barb: 50 },
  EUR: { x: 511.66, y: 109.68, code: "EUR", city: "FRANKFURT", lx: 12, ly: 16, anchor: "start", barb: -35 },
  JPY: { x: 867.98, y: 155.76, code: "JPY", city: "TOKYO", lx: 12, ly: 16, anchor: "start", barb: 30 },
} as const;
export type HubCode = keyof typeof HUBS;

export const FRONTS: Record<Corridor, { curve: Curve; hubs: [HubCode, HubCode]; pill: [number, number] }> = {
  "GBP-USD": { curve: [286.72, 139.76, 387.22, 94.76, 487.73, 105.2], hubs: ["USD", "GBP"], pill: [387, 80] },
  "EUR-USD": { curve: [286.72, 139.76, 399.19, 131.76, 511.66, 109.68], hubs: ["USD", "EUR"], pill: [400, 190] },
  "EUR-JPY": { curve: [511.66, 109.68, 689.82, 169.68, 867.98, 155.76], hubs: ["EUR", "JPY"], pill: [690, 196] },
  "USD-JPY": { curve: [286.72, 139.76, 577.35, -90, 867.98, 155.76], hubs: ["USD", "JPY"], pill: [577, 54] },
};

export const CORRIDOR_HUB_LINKS: Record<HubCode, Corridor[]> = {
  USD: ["USD-JPY", "EUR-USD", "GBP-USD"],
  GBP: ["GBP-USD"],
  EUR: ["EUR-JPY", "EUR-USD"],
  JPY: ["USD-JPY", "EUR-JPY"],
};

export const CYCLONE = { x: 867.98, y: 155.76 };

export const INK = { cream: "#efe6d0", amber: "#ffb000", vermilion: "#ff4a1c", blue: "#10284a" } as const;
export const STATE_COLOR: Record<StormState, string> = { calm: INK.cream, spreading: INK.amber, storm: INK.vermilion };
export const STATE_NAME: Record<StormState, string> = { calm: "CALM", spreading: "SPREADING", storm: "STORM" };

export const curvePath = ([x0, y0, cx, cy, x1, y1]: Curve) => `M${x0} ${y0} Q${cx} ${cy} ${x1} ${y1}`;

/** Point and tangent angle (radians) at u in 0..1 along a quadratic curve. */
export function curvePoint([x0, y0, cx, cy, x1, y1]: Curve, u: number) {
  const m = 1 - u;
  return {
    x: m * m * x0 + 2 * m * u * cx + u * u * x1,
    y: m * m * y0 + 2 * m * u * cy + u * u * y1,
    a: Math.atan2(2 * m * (cy - y0) + 2 * u * (y1 - cy), 2 * m * (cx - x0) + 2 * u * (x1 - cx)),
  };
}

/** Front marks along a curve. Spreading: semicircles. Storm: triangles alternating with semicircles. */
export function frontMarks(curve: Curve, state: StormState, n = 8) {
  if (state === "calm") return [];
  return Array.from({ length: n }, (_, j) => {
    const p = curvePoint(curve, 0.15 + (j * 0.7) / (n - 1));
    return { x: p.x, y: p.y, deg: (p.a * 180) / Math.PI, tri: state === "storm" && j % 2 === 0 };
  });
}

/** Isobar rings around the Tokyo low: more of them, closer together, as risk (0..1) rises. */
export function isobars(risk: number) {
  const n = 1 + Math.round(risk * 7);
  const gap = 30 - 16 * risk;
  return Array.from({ length: n }, (_, i) => {
    const rx = 16 + (i + 1) * gap;
    return { rx, ry: rx * 0.78, rot: -24 + i * 11, opacity: 0.95 - i * 0.07, w: i === 0 ? 1.7 : 1.1 };
  });
}
