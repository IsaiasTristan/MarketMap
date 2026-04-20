/**
 * Tests for rolling multivariate OLS.
 */
import { describe, it, expect } from "vitest";
import { rollingMultivariateOls, extractRollingBeta } from "../../src/lib/factors/regression/rolling";
import { minObservations } from "../../src/lib/factors/definitions/model-presets";

function makeDates(n: number): string[] {
  const base = new Date("2023-01-02");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

describe("rollingMultivariateOls", () => {
  it("returns empty array when n < window", () => {
    const n = 10;
    const dates = makeDates(n);
    const y = Array.from({ length: n }, () => Math.random() * 0.01);
    const X = Array.from({ length: n }, () => [Math.random() * 0.01]);
    const fits = rollingMultivariateOls(dates, y, X, 252);
    expect(fits).toHaveLength(0);
  });

  it("produces one fit per date after the window", () => {
    const n = 100;
    const window = 40; // > minObservations(1) = 32
    const dates = makeDates(n);
    const y = Array.from({ length: n }, () => Math.random() * 0.01);
    const X = Array.from({ length: n }, () => [Math.random() * 0.01]);
    const fits = rollingMultivariateOls(dates, y, X, window);
    expect(fits.length).toBe(n - window + 1);
    expect(fits[0]!.date).toBe(dates[window - 1]);
    expect(fits[fits.length - 1]!.date).toBe(dates[n - 1]);
  });

  it("each fit has betas of correct length", () => {
    const n = 80;
    const k = 3;
    const dates = makeDates(n);
    const y = Array.from({ length: n }, () => Math.random() * 0.01);
    const X = Array.from({ length: n }, () =>
      Array.from({ length: k }, () => Math.random() * 0.01),
    );
    const fits = rollingMultivariateOls(dates, y, X, 60);
    for (const { fit } of fits) {
      expect(fit.betas).toHaveLength(k);
      expect(fit.k).toBe(k);
    }
  });

  it("extractRollingBeta returns correct arrays for a given factor index", () => {
    const n = 80;
    const dates = makeDates(n);
    const y = Array.from({ length: n }, () => Math.random() * 0.01);
    const X = Array.from({ length: n }, () => [Math.random() * 0.01, Math.random() * 0.01]);
    const fits = rollingMultivariateOls(dates, y, X, 60);

    const { dates: d0, betas: b0 } = extractRollingBeta(fits, 0);
    const { dates: d1, betas: b1 } = extractRollingBeta(fits, 1);

    expect(d0).toHaveLength(fits.length);
    expect(b0).toHaveLength(fits.length);
    expect(d0).toEqual(d1);
    // Betas for factor 0 and factor 1 should differ (independent random factors)
    expect(b0.some((v, i) => Math.abs(v - b1[i]!) > 1e-8)).toBe(true);
  });
});

describe("minObservations", () => {
  it("follows the 2k+30 rule", () => {
    expect(minObservations(1)).toBe(32);
    expect(minObservations(5)).toBe(40);
    expect(minObservations(6)).toBe(42);
  });
});
