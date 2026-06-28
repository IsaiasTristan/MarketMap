import { describe, expect, it } from "vitest";
import {
  compositeScores,
  isNewArrival,
  rankAndDecile,
  winsorize,
  zScores,
} from "@/lib/revision/scoring";

describe("winsorize", () => {
  it("clamps extremes to the quantile bounds", () => {
    const v = [-100, 1, 2, 3, 4, 5, 100];
    const w = winsorize(v, 0.2);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...w)).toBeLessThanOrEqual(5);
  });
});

describe("zScores", () => {
  it("standardizes finite entries by original index", () => {
    const { z, mean, std } = zScores([0, 10, 20, null, 30, 40]);
    expect(mean).toBeCloseTo(20, 6);
    expect(std).toBeGreaterThan(0);
    expect(z.get(0)).toBeCloseTo((0 - 20) / std, 6);
    expect(z.has(3)).toBe(false); // null skipped
  });
  it("returns empty z when variance collapses", () => {
    const { z } = zScores([5, 5, 5, 5]);
    expect(z.size).toBe(0);
  });
});

describe("compositeScores", () => {
  it("averages available z-scores per index with optional weights", () => {
    const a = new Map([[0, 1], [1, -1]]);
    const b = new Map([[0, 3], [1, 1]]);
    const eq = compositeScores([{ key: "a", z: a }, { key: "b", z: b }], 2);
    expect(eq[0]).toBeCloseTo(2, 6);
    expect(eq[1]).toBeCloseTo(0, 6);
    const weighted = compositeScores([{ key: "a", z: a }, { key: "b", z: b }], 2, { a: 3, b: 1 });
    expect(weighted[0]).toBeCloseTo((1 * 3 + 3 * 1) / 4, 6);
  });
  it("is null when an index has no z-scores", () => {
    const out = compositeScores([{ key: "a", z: new Map([[0, 1]]) }], 2);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeNull();
  });
});

describe("rankAndDecile", () => {
  it("ranks descending and assigns deciles with 10 strongest", () => {
    const composites = Array.from({ length: 20 }, (_, i) => i); // 0..19
    const ranked = rankAndDecile(composites);
    const top = ranked.find((e) => e.index === 19)!;
    const bottom = ranked.find((e) => e.index === 0)!;
    expect(top.rank).toBe(1);
    expect(top.decile).toBe(10);
    expect(bottom.decile).toBe(1);
  });
  it("excludes nulls", () => {
    expect(rankAndDecile([null, null]).length).toBe(0);
  });
});

describe("isNewArrival", () => {
  it("fires when entering the top decile from below or absent", () => {
    expect(isNewArrival(10, 5)).toBe(true);
    expect(isNewArrival(9, null)).toBe(true);
    expect(isNewArrival(10, 9)).toBe(false); // already top
    expect(isNewArrival(8, 2)).toBe(false); // not top
    expect(isNewArrival(null, 1)).toBe(false);
  });
});
