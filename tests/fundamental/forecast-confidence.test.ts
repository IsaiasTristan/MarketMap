import { describe, expect, it } from "vitest";
import {
  dispersion,
  forecastConfidenceComponents,
} from "@/lib/fundamental/forecast-confidence";

describe("dispersion", () => {
  it("computes (high - low) / |avg|", () => {
    expect(dispersion({ low: 0.9, avg: 1.0, high: 1.1 })!).toBeCloseTo(0.2, 9);
  });
  it("returns null for an incomplete triple", () => {
    expect(dispersion({ low: null, avg: 1, high: 2 })).toBeNull();
    expect(dispersion(null)).toBeNull();
  });
});

describe("forecastConfidenceComponents", () => {
  const base = {
    eps: { low: 0.9, avg: 1.0, high: 1.1 },
    revenue: { low: 95, avg: 100, high: 105 },
    ebitda: { low: 18, avg: 20, high: 22 },
    priorEpsDispersion: 0.4,
    numAnalystsEps: 8,
    numAnalystsRevenue: 7,
    epsSurpriseHistory: [0.02, 0.01, 0.03],
  };
  it("inverts dispersion (tight consensus scores higher)", () => {
    const c = forecastConfidenceComponents(base);
    expect(c.epsDispQuality!).toBeLessThan(0); // -dispersion
    expect(c.revDispQuality).not.toBeNull();
    expect(c.ebitdaDispQuality).not.toBeNull();
    // dispersion fell 0.4 -> 0.2 => improving => positive dispChangeQuality
    expect(c.dispChangeQuality!).toBeGreaterThan(0);
    expect(c.analystCoverage).toBe(8);
  });
  it("suppresses dispersion for single-analyst (<3) coverage", () => {
    const c = forecastConfidenceComponents({
      ...base,
      numAnalystsEps: 1,
      numAnalystsRevenue: 1,
    });
    expect(c.epsDispQuality).toBeNull();
    expect(c.revDispQuality).toBeNull();
    expect(c.ebitdaDispQuality).toBeNull();
    // coverage level is still reported (drives the ESTIMATE COVERAGE LOW flag)
    expect(c.analystCoverage).toBe(1);
  });
  it("nulls dispersion when estimates are missing", () => {
    const c = forecastConfidenceComponents({
      ...base,
      eps: null,
      revenue: null,
      ebitda: null,
    });
    expect(c.epsDispQuality).toBeNull();
    expect(c.dispChangeQuality).toBeNull();
  });
});
