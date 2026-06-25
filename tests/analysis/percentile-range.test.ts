import { describe, expect, it } from "vitest";
import {
  quantileSorted,
  percentileColumnRanges,
} from "@/domain/calculations/percentile-range";
import type { Horizon } from "@/domain/entities/horizons";

describe("quantileSorted", () => {
  it("returns 0 for empty input and the element for a singleton", () => {
    expect(quantileSorted([], 0.5)).toBe(0);
    expect(quantileSorted([7], 0.95)).toBe(7);
  });

  it("interpolates linearly between neighbors", () => {
    const arr = [0, 10, 20, 30, 40];
    expect(quantileSorted(arr, 0)).toBe(0);
    expect(quantileSorted(arr, 1)).toBe(40);
    expect(quantileSorted(arr, 0.5)).toBe(20);
    expect(quantileSorted(arr, 0.25)).toBe(10);
  });

  it("clamps q outside [0, 1]", () => {
    const arr = [1, 2, 3];
    expect(quantileSorted(arr, -1)).toBe(1);
    expect(quantileSorted(arr, 5)).toBe(3);
  });
});

describe("percentileColumnRanges", () => {
  const H = "D1" as Horizon;

  function rowsFrom(values: number[]) {
    return values.map((v) => ({ cells: { [H]: v } as Record<Horizon, number | null> }));
  }

  it("winsorizes extreme tails so a single outlier does not set the span", () => {
    // 99 values near zero plus one extreme -50 outlier.
    const values = [...Array(99).fill(1), -50];
    const { min, max } = percentileColumnRanges(rowsFrom(values), [H], 0.05);
    // The -50 outlier sits below the 5th percentile, so min clamps well above it.
    expect(min[H]).toBeGreaterThan(-50);
    expect(max[H]).toBe(1);
  });

  it("returns the p5/p95 quantiles of the distribution", () => {
    const values = Array.from({ length: 101 }, (_, i) => i); // 0..100
    const { min, max } = percentileColumnRanges(rowsFrom(values), [H], 0.05);
    expect(min[H]).toBeCloseTo(5, 6);
    expect(max[H]).toBeCloseTo(95, 6);
  });

  it("ignores null and non-finite cells", () => {
    const rows = [
      { cells: { [H]: 1 } as Record<Horizon, number | null> },
      { cells: { [H]: null } as Record<Horizon, number | null> },
      { cells: { [H]: Number.NaN } as Record<Horizon, number | null> },
      { cells: { [H]: 3 } as Record<Horizon, number | null> },
    ];
    // Only the two finite cells (1, 3) feed the quantiles: p5 = 1.1, p95 = 2.9.
    const { min, max } = percentileColumnRanges(rows, [H], 0.05);
    expect(min[H]).toBeCloseTo(1.1, 6);
    expect(max[H]).toBeCloseTo(2.9, 6);
  });

  it("returns a zero range when no finite data is present", () => {
    const { min, max } = percentileColumnRanges(rowsFrom([]), [H], 0.05);
    expect(min[H]).toBe(0);
    expect(max[H]).toBe(0);
  });
});
