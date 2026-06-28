import { describe, expect, it } from "vitest";
import {
  EPS_DENOM_FLOOR,
  surpriseComponents,
  surpriseRatio,
} from "@/lib/fundamental/surprise";

describe("surpriseRatio", () => {
  it("is positive on a beat, negative on a miss", () => {
    expect(surpriseRatio(1.5, 1.0, EPS_DENOM_FLOOR)!).toBeGreaterThan(0);
    expect(surpriseRatio(0.8, 1.0, EPS_DENOM_FLOOR)!).toBeLessThan(0);
  });
  it("handles a negative-to-positive EPS crossing as a strong beat", () => {
    // expected a loss, reported a profit
    const s = surpriseRatio(0.2, -0.3, EPS_DENOM_FLOOR)!;
    expect(s).toBeGreaterThan(0);
  });
  it("uses the floor for near-zero expectations (no explosion)", () => {
    const s = surpriseRatio(0.05, 0.0001, EPS_DENOM_FLOOR)!;
    // denom floored at 0.25, so ~ (0.05-0.0001)/0.25 ≈ 0.2, not thousands
    expect(Math.abs(s)).toBeLessThan(1);
  });
  it("returns null when either side is missing or non-finite", () => {
    expect(surpriseRatio(null, 1, EPS_DENOM_FLOOR)).toBeNull();
    expect(surpriseRatio(1, null, EPS_DENOM_FLOOR)).toBeNull();
    expect(surpriseRatio(NaN, 1, EPS_DENOM_FLOOR)).toBeNull();
  });
});

describe("surpriseComponents", () => {
  it("computes latest + 4Q-average for eps and revenue", () => {
    const c = surpriseComponents({
      eps: [
        { actual: 1.0, expected: 1.0 },
        { actual: 1.2, expected: 1.0 },
        { actual: 1.1, expected: 1.0 },
        { actual: 1.5, expected: 1.0 },
      ],
      revenue: [
        { actual: 100, expected: 100 },
        { actual: 110, expected: 100 },
      ],
    });
    expect(c.latestEpsSurprise).toBeGreaterThan(0); // last was a beat
    expect(c.avg4EpsSurprise).toBeGreaterThan(0);
    expect(c.latestRevenueSurprise).toBeGreaterThan(0);
    expect(c.avg4RevenueSurprise).toBeGreaterThan(0);
  });
  it("returns nulls when there is no surprise history", () => {
    const c = surpriseComponents({ eps: [], revenue: [] });
    expect(c.latestEpsSurprise).toBeNull();
    expect(c.avg4EpsSurprise).toBeNull();
  });
});
