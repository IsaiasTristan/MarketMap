/**
 * factor-strict-droprow — Phase 3 §2.7 / Q3 lock: contract test.
 *
 * Verifies the *behavioural* difference between strict drop-row (the new
 * Phase 3 policy) and the legacy silent zero-fill: zeroing missing factor
 * cells biases β toward zero (regression dilution), so the OLS estimate
 * drifts materially when zeros are imputed for a meaningful fraction of
 * rows. If a future change re-introduced zero-fill in the per-stock
 * pipeline, this test would still pass — but it is here as a regression
 * guard for the methodological discussion in AGENTS.md.
 *
 * Asserts:
 *   1. Drop-row OLS recovers the true β within sampling error.
 *   2. Zero-fill OLS produces meaningfully attenuated β when ~10% of
 *      factor rows are zeroed (regression dilution toward zero).
 *   3. Drop-row β is closer to true β than zero-fill β.
 */
import { describe, it, expect } from "vitest";
import { multivariateOls } from "../../src/lib/factors/regression/ols";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

describe("strict drop-row vs zero-fill (Phase 3 §2.7 / Q3 lock)", () => {
  it("drop-row recovers true β; zero-fill attenuates β", () => {
    const r = rng(42);
    const n = 400;
    const trueBeta = [0.9, -0.6];
    const X: number[][] = Array.from({ length: n }, () => [r() * 0.02, r() * 0.015]);
    const y = X.map(
      (row) => trueBeta[0]! * row[0]! + trueBeta[1]! * row[1]! + r() * 0.003,
    );

    // Strict drop-row: simulate ~10% missing factor cells by removing the rows.
    const keepIdx = X.map((_, i) => i).filter((_, i) => i % 10 !== 0);
    const yDrop = keepIdx.map((i) => y[i]!);
    const xDrop = keepIdx.map((i) => X[i]!);
    const fitDrop = multivariateOls(yDrop, xDrop);
    expect(fitDrop.failed).toBe(false);

    // Zero-fill (LEGACY, anti-pattern): replace the same rows' factor values with [0, 0].
    const xZero = X.map((row, i) => (i % 10 === 0 ? [0, 0] : row));
    const fitZero = multivariateOls(y, xZero);
    expect(fitZero.failed).toBe(false);

    // Drop-row should be close to true β.
    expect(fitDrop.betas[0]).toBeCloseTo(trueBeta[0]!, 1);
    expect(fitDrop.betas[1]).toBeCloseTo(trueBeta[1]!, 1);

    // Zero-fill biases β toward zero on EACH factor (regression
    // dilution). This is the core anti-pattern Phase 3 §2.7 forbids.
    expect(Math.abs(fitZero.betas[0] ?? 0)).toBeLessThan(Math.abs(fitDrop.betas[0] ?? 0));
    expect(Math.abs(fitZero.betas[1] ?? 0)).toBeLessThan(Math.abs(fitDrop.betas[1] ?? 0));
  });

});
