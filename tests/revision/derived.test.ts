import { describe, expect, it } from "vitest";
import {
  computeStreak,
  decomposeComposites,
  dispersionTrend,
  lsSlope,
  pickStreakSource,
  trailingMean,
} from "@/lib/revision/derived";

describe("trailingMean", () => {
  it("means the last `window` entries", () => {
    expect(trailingMean([1, 2, 3, 4, 5], 4)).toEqual({ value: 3.5, weeksUsed: 4 });
  });
  it("clamps to available history and reports the effective window", () => {
    expect(trailingMean([2], 4)).toEqual({ value: 2, weeksUsed: 1 });
    expect(trailingMean([1, 3], 4)).toEqual({ value: 2, weeksUsed: 2 });
  });
  it("skips nulls inside the window", () => {
    expect(trailingMean([1, null, 3, null], 4)).toEqual({ value: 2, weeksUsed: 2 });
  });
  it("is null with no finite observations", () => {
    expect(trailingMean([null, null], 4)).toEqual({ value: null, weeksUsed: 0 });
    expect(trailingMean([], 4)).toEqual({ value: null, weeksUsed: 0 });
  });
});

describe("computeStreak", () => {
  it("counts the trailing same-sign run", () => {
    expect(computeStreak([-1, 0.5, 0.2, 0.9])).toEqual({ len: 3, sign: 1 });
    expect(computeStreak([1, -0.5, -0.1])).toEqual({ len: 2, sign: -1 });
  });
  it("breaks on nulls and zeros", () => {
    expect(computeStreak([0.5, null, 0.2])).toEqual({ len: 1, sign: 1 });
    expect(computeStreak([0.5, 0, 0.2])).toEqual({ len: 1, sign: 1 });
    expect(computeStreak([0.5, 0.2, null])).toEqual({ len: 0, sign: 0 });
  });
  it("is zero for empty / all-null series", () => {
    expect(computeStreak([])).toEqual({ len: 0, sign: 0 });
    expect(computeStreak([null, null])).toEqual({ len: 0, sign: 0 });
  });
  it("handles a 1-week series (sparse Leg A)", () => {
    expect(computeStreak([0.3])).toEqual({ len: 1, sign: 1 });
  });
});

describe("pickStreakSource", () => {
  it("uses Leg B until Leg A depth reaches the minimum", () => {
    expect(pickStreakSource(2)).toBe("LEG_B");
    expect(pickStreakSource(5)).toBe("LEG_B");
    expect(pickStreakSource(6)).toBe("LEG_A"); // boundary is inclusive
    expect(pickStreakSource(40)).toBe("LEG_A");
  });
});

describe("decomposeComposites", () => {
  it("splits composite into group + idio with idio = composite - groupZ", () => {
    // Two groups of three: A strong (mean 1.0), B weak (mean -1.0).
    const composites = [1.5, 1.0, 0.5, -0.5, -1.0, -1.5];
    const keys = ["A", "A", "A", "B", "B", "B"];
    const { groupZ, idioZ, groupZByKey } = decomposeComposites(composites, keys);
    expect(groupZByKey.get("A")!).toBeGreaterThan(0);
    expect(groupZByKey.get("B")!).toBeLessThan(0);
    for (let i = 0; i < composites.length; i++) {
      expect(idioZ[i]!).toBeCloseTo(composites[i]! - groupZ[i]!, 12);
    }
    // Within group A the strongest name has the highest idio.
    expect(idioZ[0]!).toBeGreaterThan(idioZ[2]!);
  });
  it("returns null group/idio when only one group exists (z collapses)", () => {
    const { groupZ, idioZ } = decomposeComposites([1, 2, 3], ["A", "A", "A"]);
    expect(groupZ).toEqual([null, null, null]);
    expect(idioZ).toEqual([null, null, null]);
  });
  it("propagates null composites into idio", () => {
    const { idioZ } = decomposeComposites([null, 1, -1, 0.5], ["A", "A", "B", "B"]);
    expect(idioZ[0]).toBeNull();
  });
});

describe("lsSlope", () => {
  it("recovers the slope of a line", () => {
    expect(lsSlope([1, 2, 3, 4])!).toBeCloseTo(1, 12);
    expect(lsSlope([4, 2, 0])!).toBeCloseTo(-2, 12);
  });
  it("is null under 2 finite points", () => {
    expect(lsSlope([1])).toBeNull();
    expect(lsSlope([null, 1, null])).toBeNull();
  });
});

describe("dispersionTrend", () => {
  it("labels a clearly falling series NARROWING and a rising one WIDENING", () => {
    expect(dispersionTrend([0.5, 0.4, 0.3, 0.2])).toBe("NARROWING");
    expect(dispersionTrend([0.2, 0.3, 0.4, 0.5])).toBe("WIDENING");
  });
  it("labels a near-flat series FLAT via the level-scaled band", () => {
    expect(dispersionTrend([0.30, 0.301, 0.299, 0.30])).toBe("FLAT");
  });
  it("is null under 3 finite points (Leg A accruing)", () => {
    expect(dispersionTrend([0.5, 0.4])).toBeNull();
    expect(dispersionTrend([null, 0.5, null, 0.4])).toBeNull();
    expect(dispersionTrend([])).toBeNull();
  });
});
