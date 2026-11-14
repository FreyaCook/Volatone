import { describe, expect, it } from "vitest";
import { curvePoint, frontMarks, FRONTS, isobars } from "./geometry";

describe("chart geometry", () => {
  it("calm has no front marks, spreading has semicircles only, storm mixes in triangles", () => {
    const c = FRONTS["EUR-JPY"].curve;
    expect(frontMarks(c, "calm")).toHaveLength(0);
    expect(frontMarks(c, "spreading").every((m) => !m.tri)).toBe(true);
    const storm = frontMarks(c, "storm");
    expect(storm.some((m) => m.tri)).toBe(true);
    expect(storm.some((m) => !m.tri)).toBe(true);
  });

  it("isobars multiply and tighten as risk rises", () => {
    const calm = isobars(0), storm = isobars(1);
    expect(storm.length).toBeGreaterThan(calm.length);
    const gap = (r: ReturnType<typeof isobars>) => r[1].rx - r[0].rx;
    expect(gap(storm)).toBeLessThan(gap(isobars(0.2)));
  });

  it("a curve starts and ends at its hubs", () => {
    const c = FRONTS["USD-JPY"].curve;
    expect(curvePoint(c, 0)).toMatchObject({ x: c[0], y: c[1] });
    expect(curvePoint(c, 1)).toMatchObject({ x: c[4], y: c[5] });
  });
});
