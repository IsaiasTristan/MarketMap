/**
 * Tests for the multivariate OLS regression engine.
 */
import { describe, it, expect } from "vitest";
import { multivariateOls } from "../../src/lib/factors/regression/ols";

// Helper: generate synthetic data from known betas
function syntheticData(
  alpha: number,
  betas: number[],
  X: number[][],
  noise = 0,
): number[] {
  return X.map((row) => {
    const systematic = row.reduce((s, x, i) => s + (betas[i] ?? 0) * x, 0);
    return alpha + systematic + (noise > 0 ? (Math.random() - 0.5) * noise : 0);
  });
}

describe("multivariateOls", () => {
  it("recovers known betas on noise-free data", () => {
    const n = 100;
    const trueBetas = [1.2, -0.5, 0.8];
    const trueAlpha = 0.001;

    // Generate X: 3 factors, 100 observations
    const X: number[][] = Array.from({ length: n }, () => [
      (Math.random() - 0.5) * 0.02,   // MKT-like
      (Math.random() - 0.5) * 0.01,   // SMB-like
      (Math.random() - 0.5) * 0.005,  // HML-like
    ]);
    const y = syntheticData(trueAlpha, trueBetas, X, 0);

    const fit = multivariateOls(y, X);

    expect(fit.k).toBe(3);
    expect(fit.n).toBe(100);
    expect(fit.betas[0]).toBeCloseTo(trueBetas[0]!, 4);
    expect(fit.betas[1]).toBeCloseTo(trueBetas[1]!, 4);
    expect(fit.betas[2]).toBeCloseTo(trueBetas[2]!, 4);
    expect(fit.alpha).toBeCloseTo(trueAlpha, 6);
    expect(fit.rSquared).toBeCloseTo(1.0, 4);
  });

  it("recovers betas on noisy data within reasonable bounds", () => {
    const n = 500;
    const trueBetas = [1.1, -0.4, 0.6];
    const X: number[][] = Array.from({ length: n }, () => [
      (Math.random() - 0.5) * 0.02,
      (Math.random() - 0.5) * 0.01,
      (Math.random() - 0.5) * 0.008,
    ]);
    const y = syntheticData(0, trueBetas, X, 0.01);

    const fit = multivariateOls(y, X);

    expect(fit.betas[0]).toBeCloseTo(trueBetas[0]!, 0);
    expect(fit.betas[1]).toBeCloseTo(trueBetas[1]!, 0);
    expect(fit.betas[2]).toBeCloseTo(trueBetas[2]!, 0);
    expect(fit.rSquared).toBeGreaterThan(0.3);
  });

  it("returns fallback fit when n < k + 2", () => {
    const y = [0.01, 0.02];
    const X = [[0.01, 0.02, 0.03], [0.01, 0.02, 0.03]]; // n=2, k=3 → insufficient
    const fit = multivariateOls(y, X);
    expect(fit.betas.every((b) => b === 0)).toBe(true);
    expect(fit.regularized).toBe(false);
  });

  it("handles near-singular X'X with ridge regularization", () => {
    // Perfectly collinear factors → singular matrix
    const n = 50;
    const factor = Array.from({ length: n }, () => Math.random() * 0.01);
    const X: number[][] = factor.map((f) => [f, f * 2, f * 3]); // rank-1
    const y = factor.map((f) => 1.5 * f + 0.001);

    const fit = multivariateOls(y, X);
    expect(fit.regularized).toBe(true);
    expect(isFinite(fit.betas[0]!)).toBe(true);
    expect(isFinite(fit.rSquared)).toBe(true);
  });

  it("computes t-stats with correct sign and returns significant results for strong signal", () => {
    const n = 252;
    const X: number[][] = Array.from({ length: n }, () => [(Math.random() - 0.5) * 0.02]);
    const y = X.map((row) => 1.5 * row[0]! + (Math.random() - 0.5) * 0.001);

    const fit = multivariateOls(y, X);
    expect(Math.abs(fit.tStats[0]!)).toBeGreaterThan(10); // strong signal → high t
    expect(fit.tStats[0]! > 0).toBe(true); // positive beta → positive t
  });

  it("R-squared is between 0 and 1", () => {
    const n = 80;
    const X: number[][] = Array.from({ length: n }, () => [(Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.01]);
    const y = X.map((row) => 0.8 * row[0]! + 0.3 * row[1]! + (Math.random() - 0.5) * 0.005);
    const fit = multivariateOls(y, X);
    expect(fit.rSquared).toBeGreaterThanOrEqual(0);
    expect(fit.rSquared).toBeLessThanOrEqual(1);
    expect(fit.adjRSquared).toBeLessThanOrEqual(fit.rSquared);
  });
});
