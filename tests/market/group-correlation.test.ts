/**
 * Pure tests for `computeGroupReturnCorrelations` — the sector / sub-theme
 * price-performance correlation builder behind the Price-correlations tab.
 */
import { describe, it, expect } from "vitest";
import {
  computeGroupReturnCorrelations,
  type ReturnGroup,
} from "../../src/domain/calculations/group-correlation";

function group(key: string, returns: Record<string, number>): ReturnGroup {
  return { key, returnsByDate: new Map(Object.entries(returns)) };
}

const DATES = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];

describe("computeGroupReturnCorrelations", () => {
  it("returns an empty result for no groups", () => {
    const r = computeGroupReturnCorrelations([], 252);
    expect(r.labels).toEqual([]);
    expect(r.matrix).toEqual([]);
    expect(r.obs).toBe(0);
    expect(r.asOf).toBeNull();
  });

  it("has a unit diagonal and is symmetric", () => {
    const a = group("A", { [DATES[0]!]: 0.01, [DATES[1]!]: -0.02, [DATES[2]!]: 0.03 });
    const b = group("B", { [DATES[0]!]: 0.02, [DATES[1]!]: 0.01, [DATES[2]!]: -0.01 });
    const r = computeGroupReturnCorrelations([a, b], 252);
    expect(r.labels).toEqual(["A", "B"]);
    expect(r.matrix[0]![0]).toBe(1);
    expect(r.matrix[1]![1]).toBe(1);
    expect(r.matrix[0]![1]).toBeCloseTo(r.matrix[1]![0]!, 12);
  });

  it("detects a perfect positive correlation", () => {
    const a = group("A", { [DATES[0]!]: 0.01, [DATES[1]!]: 0.02, [DATES[2]!]: 0.03 });
    const b = group("B", { [DATES[0]!]: 0.02, [DATES[1]!]: 0.04, [DATES[2]!]: 0.06 });
    const r = computeGroupReturnCorrelations([a, b], 252);
    expect(r.matrix[0]![1]).toBeCloseTo(1, 10);
  });

  it("detects a perfect negative correlation", () => {
    const a = group("A", { [DATES[0]!]: 0.01, [DATES[1]!]: 0.02, [DATES[2]!]: 0.03 });
    const b = group("B", { [DATES[0]!]: -0.01, [DATES[1]!]: -0.02, [DATES[2]!]: -0.03 });
    const r = computeGroupReturnCorrelations([a, b], 252);
    expect(r.matrix[0]![1]).toBeCloseTo(-1, 10);
  });

  it("correlates pairwise over only the overlapping dates", () => {
    // B is missing DATES[0]; the pair must still correlate over the 3 shared days.
    const a = group("A", {
      [DATES[0]!]: 0.05,
      [DATES[1]!]: 0.01,
      [DATES[2]!]: 0.02,
      [DATES[3]!]: 0.03,
    });
    const b = group("B", {
      [DATES[1]!]: 0.02,
      [DATES[2]!]: 0.04,
      [DATES[3]!]: 0.06,
    });
    const r = computeGroupReturnCorrelations([a, b], 252);
    expect(r.matrix[0]![1]).toBeCloseTo(1, 10);
    expect(r.obs).toBe(4); // union calendar spans all four days
  });

  it("trims to the last `window` trading days of the union calendar", () => {
    const a = group("A", {
      [DATES[0]!]: 0.01,
      [DATES[1]!]: 0.02,
      [DATES[2]!]: 0.03,
      [DATES[3]!]: 0.04,
    });
    const b = group("B", {
      [DATES[0]!]: 0.04,
      [DATES[1]!]: 0.03,
      [DATES[2]!]: 0.02,
      [DATES[3]!]: 0.01,
    });
    const r = computeGroupReturnCorrelations([a, b], 2);
    expect(r.obs).toBe(2);
    expect(r.asOf).toBe(DATES[3]);
  });

  it("yields 0 for a pair with fewer than two overlapping dates", () => {
    const a = group("A", { [DATES[0]!]: 0.01 });
    const b = group("B", { [DATES[1]!]: 0.02 });
    const r = computeGroupReturnCorrelations([a, b], 252);
    expect(r.matrix[0]![1]).toBe(0);
  });
});
