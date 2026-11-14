import { describe, expect, it } from "vitest";
import { tensionFor } from "./sound";

describe("tensionFor", () => {
  it("rises with the number of corridors in storm and stays within 0..1", () => {
    const t = [0, 1, 2, 3, 4].map(tensionFor);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(t[0]).toBe(0);
    expect(t[4]).toBe(1);
    expect(tensionFor(9)).toBe(1);
  });
});
