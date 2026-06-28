import { describe, expect, it } from "vitest";
import { clampValue, robustDomain } from "@/lib/fundamental/robust-domain";

describe("robustDomain", () => {
  it("clips extreme outliers out of the domain so the bulk spreads", () => {
    // Realistic case: 200 normal names plus a couple pre-revenue-style blowouts
    // (~1% of the set, below the top-2% clip), so the 98th-pct bound stays in the bulk.
    const bulk = Array.from({ length: 200 }, (_, i) => i); // 0..199
    const vals = [...bulk, 1_000_000, 1_000_000];
    const dom = robustDomain(vals, { pad: 0 })!;
    expect(dom).not.toBeNull();
    // Upper bound stays near the bulk, nowhere near the 1e6 outliers.
    expect(dom[1]).toBeLessThan(300);
    expect(dom[0]).toBeLessThanOrEqual(5);
  });

  it("applies symmetric padding as a fraction of the clipped span", () => {
    const vals = Array.from({ length: 101 }, (_, i) => i); // 0..100
    const noPad = robustDomain(vals, { loP: 0, hiP: 1, pad: 0 })!;
    const padded = robustDomain(vals, { loP: 0, hiP: 1, pad: 0.05 })!;
    expect(noPad[0]).toBeCloseTo(0, 6);
    expect(noPad[1]).toBeCloseTo(100, 6);
    expect(padded[0]).toBeCloseTo(-5, 6);
    expect(padded[1]).toBeCloseTo(105, 6);
  });

  it("returns null below the minimum finite count (caller falls back to auto)", () => {
    expect(robustDomain([1, 2, 3], { minCount: 5 })).toBeNull();
    expect(robustDomain([], { minCount: 5 })).toBeNull();
  });

  it("ignores null/undefined/non-finite entries when counting", () => {
    // 5 finite entries (1..5) clear minCount 5; 6 finite needed -> null.
    expect(robustDomain([1, null, 2, undefined, 3, NaN, Infinity, 4, 5], { minCount: 5 })).not.toBeNull();
    expect(robustDomain([1, null, 2, undefined, 3, NaN, Infinity, 4, 5], { minCount: 6 })).toBeNull();
  });

  it("nudges a degenerate (all-equal) band so the axis keeps a span", () => {
    const dom = robustDomain([7, 7, 7, 7, 7, 7])!;
    expect(dom).not.toBeNull();
    expect(dom[0]).toBeLessThan(7);
    expect(dom[1]).toBeGreaterThan(7);
  });
});

describe("clampValue", () => {
  it("pins values to the boundary", () => {
    expect(clampValue(5, 0, 10)).toBe(5);
    expect(clampValue(-3, 0, 10)).toBe(0);
    expect(clampValue(42, 0, 10)).toBe(10);
  });
  it("passes non-finite values through unchanged", () => {
    expect(clampValue(NaN, 0, 10)).toBeNaN();
  });
});
