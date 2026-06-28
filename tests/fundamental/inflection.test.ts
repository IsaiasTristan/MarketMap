import { describe, expect, it } from "vitest";
import {
  accelerationScore,
  computeInflectionSignals,
  growthRates,
  inflectionScore,
  slope,
  trendSlope,
} from "@/lib/fundamental/inflection";

describe("slope", () => {
  it("recovers the slope of a linear series", () => {
    expect(slope([1, 2, 3, 4])).toBeCloseTo(1, 9);
    expect(slope([4, 2, 0, -2])).toBeCloseTo(-2, 9);
  });
  it("returns null with < 2 finite points", () => {
    expect(slope([1])).toBeNull();
  });
});

describe("inflectionScore", () => {
  it("is positive when a falling margin turns up (positive 2nd derivative)", () => {
    // down then up: prior slope negative, recent slope positive => positive inflection
    const series = [0.3, 0.28, 0.26, 0.24, 0.25, 0.27, 0.29, 0.31];
    expect(inflectionScore(series, 4)!).toBeGreaterThan(0);
  });
  it("is negative when a rising margin rolls over", () => {
    const series = [0.2, 0.22, 0.24, 0.26, 0.25, 0.23, 0.21, 0.19];
    expect(inflectionScore(series, 4)!).toBeLessThan(0);
  });
  it("returns null with fewer than 4 finite points", () => {
    expect(inflectionScore([0.1, null, 0.2], 4)).toBeNull();
  });
});

describe("growthRates / accelerationScore", () => {
  it("computes lagged relative change", () => {
    const g = growthRates([100, 110, 121], 1);
    expect(g[1]).toBeCloseTo(0.1, 9);
    expect(g[2]).toBeCloseTo(0.1, 9);
  });
  it("acceleration is positive when growth rates rise", () => {
    const growth = [0.01, 0.02, 0.04, 0.07];
    expect(accelerationScore(growth, 4)!).toBeGreaterThan(0);
  });
});

describe("trendSlope", () => {
  it("captures a rising ROIC trend", () => {
    expect(trendSlope([0.05, 0.06, 0.07, 0.08, 0.09], 8)!).toBeGreaterThan(0);
  });
});

describe("computeInflectionSignals", () => {
  it("flips deleveraging sign so falling net-debt/EBITDA is positive", () => {
    const falling = [4, 3.5, 3, 2.5, 2];
    const s = computeInflectionSignals({
      grossMargin: [],
      ebitdaMargin: [],
      revenueGrowthYoy: [],
      fcf: [],
      roic: [],
      netDebtToEbitda: falling,
    });
    expect(s.deleveraging!).toBeGreaterThan(0);
  });
});
