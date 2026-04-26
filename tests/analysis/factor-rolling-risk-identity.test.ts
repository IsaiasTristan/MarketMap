/**
 * factor-rolling-risk-identity — Phase 3 §2.1 (Q1 lock) unit test.
 *
 * Verifies the rolling Euler decomposition obeys the variance identity
 * on synthetic noise-free data:
 *
 *   Σ_factors pctVarianceContrib + idioShare ≡ 1   (within FP noise)
 *
 * And that for a pure-systematic synthetic series (no idio noise), the
 * idio share collapses to ~0 and systematic share ~1.
 */
import { describe, it, expect } from "vitest";
import { factorCovarianceMatrix } from "../../src/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "../../src/lib/factors/risk/decomposition";
import { multivariateOls } from "../../src/lib/factors/regression/ols";
import type { FactorCode } from "../../src/types/factors";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

describe("rolling Euler identity (Phase 3 Q1 lock)", () => {
  it("Σ pctVarianceContrib + idioShare ≡ 1 on noise-free synthetic data", () => {
    const r = rng(11);
    const n = 200;
    const trueBetas = [1.1, -0.4, 0.7];
    const X: number[][] = Array.from({ length: n }, () => [r() * 0.02, r() * 0.015, r() * 0.012]);
    // Pure systematic, zero idio.
    const y = X.map((row) => trueBetas.reduce((s, b, i) => s + b * (row[i] ?? 0), 0));

    const fit = multivariateOls(y, X);
    expect(fit.failed).toBe(false);

    const cols = [0, 1, 2].map((j) => X.map((row) => row[j]!));
    const cov = factorCovarianceMatrix(cols, null, true);
    const k = trueBetas.length;
    const dof = Math.max(1, fit.residuals.length - k - 1);
    const idioDailyVar = fit.residuals.reduce((s, e) => s + e ** 2, 0) / dof;

    const decomp = computeRiskDecomposition(
      fit.betas,
      cov,
      idioDailyVar,
      ["EQ", "RATES", "COMM"] as FactorCode[],
      n,
    );

    const sumFactors = decomp.factors.reduce((s, f) => s + f.pctVarianceContrib, 0);
    const sum = sumFactors + decomp.idiosyncraticShare;
    expect(sum).toBeCloseTo(1, 8);
    // Pure systematic — idio share collapses.
    expect(decomp.idiosyncraticShare).toBeLessThan(1e-6);
    expect(decomp.systematicShare).toBeGreaterThan(1 - 1e-6);
  });

  it("identity also holds when idio noise is added (Σ shares still = 1)", () => {
    const r = rng(31);
    const n = 400;
    const trueBetas = [0.9, 0.3, -0.6];
    const X: number[][] = Array.from({ length: n }, () => [r() * 0.02, r() * 0.015, r() * 0.012]);
    const y = X.map(
      (row) => trueBetas.reduce((s, b, i) => s + b * (row[i] ?? 0), 0) + r() * 0.01,
    );

    const fit = multivariateOls(y, X);
    expect(fit.failed).toBe(false);
    const cols = [0, 1, 2].map((j) => X.map((row) => row[j]!));
    const cov = factorCovarianceMatrix(cols, null, true);
    const k = trueBetas.length;
    const dof = Math.max(1, fit.residuals.length - k - 1);
    const idio = fit.residuals.reduce((s, e) => s + e ** 2, 0) / dof;
    const decomp = computeRiskDecomposition(
      fit.betas,
      cov,
      idio,
      ["EQ", "RATES", "COMM"] as FactorCode[],
      n,
    );
    const sum =
      decomp.factors.reduce((s, f) => s + f.pctVarianceContrib, 0) + decomp.idiosyncraticShare;
    expect(sum).toBeCloseTo(1, 8);
    expect(decomp.idiosyncraticShare).toBeGreaterThan(0);
  });
});
