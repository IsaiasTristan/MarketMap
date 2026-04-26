/**
 * factor-reconcile-snapshot — Phase 3 §3 / Q1+Q2 lock.
 *
 * End-to-end pure-math reconciliation: re-implements the Phase 3
 * snapshot-vs-rolling tie-out on synthetic data without touching the DB.
 *
 *   • Latest rolling Euler share == snapshot Euler share when rolling
 *     window length equals the snapshot regression window length.
 *   • Latest rolling total σ == snapshot model σ within FP precision.
 *
 * If this test ever fails, the per-stock services have diverged from the
 * Q1 lock (rolling W = snapshot W) and the reconcile script will start
 * dumping ✗ rows.
 */
import { describe, it, expect } from "vitest";
import { multivariateOls } from "../../src/lib/factors/regression/ols";
import { rollingMultivariateOls } from "../../src/lib/factors/regression/rolling";
import { factorCovarianceMatrix } from "../../src/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "../../src/lib/factors/risk/decomposition";
import type { FactorCode } from "../../src/types/factors";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

describe("snapshot ↔ latest rolling reconciliation (Phase 3 Q1 lock)", () => {
  it("rolling-W = snapshot-W → latest rolling Euler ties snapshot Euler exactly", () => {
    const r = rng(123);
    const n = 300;
    const W = 252;
    const X: number[][] = Array.from({ length: n }, () => [r() * 0.02, r() * 0.015, r() * 0.012]);
    const y = X.map((row) => 0.7 * row[0]! - 0.4 * row[1]! + 0.5 * row[2]! + r() * 0.005);
    const dates = Array.from({ length: n }, (_, i) => `2024-${String(((i % 12) + 1)).padStart(2, "0")}-01`);

    // SNAPSHOT — last W observations.
    const yEnd = y.slice(-W);
    const xEnd = X.slice(-W);
    const snap = multivariateOls(yEnd, xEnd);
    expect(snap.failed).toBe(false);
    const cols = [0, 1, 2].map((j) => xEnd.map((row) => row[j]!));
    const covSnap = factorCovarianceMatrix(cols, null, true);
    const k = 3;
    const idioDailySnap = snap.residuals.reduce((s, e) => s + e ** 2, 0) / Math.max(1, snap.residuals.length - k - 1);
    const decompSnap = computeRiskDecomposition(
      snap.betas,
      covSnap,
      idioDailySnap,
      ["EQ", "RATES", "COMM"] as FactorCode[],
      W,
    );

    // ROLLING — same W; latest fit ends at last index.
    const fits = rollingMultivariateOls(dates, y, X, W);
    const lastFit = fits[fits.length - 1]!.fit;
    expect(lastFit.failed).toBe(false);
    const xLast = X.slice(n - W, n);
    const colsLast = [0, 1, 2].map((j) => xLast.map((row) => row[j]!));
    const covLast = factorCovarianceMatrix(colsLast, null, true);
    const idioDailyLast = lastFit.residuals.reduce((s, e) => s + e ** 2, 0) / Math.max(1, lastFit.residuals.length - k - 1);
    const decompLast = computeRiskDecomposition(
      lastFit.betas,
      covLast,
      idioDailyLast,
      ["EQ", "RATES", "COMM"] as FactorCode[],
      W,
    );

    // Betas tie exactly.
    for (let i = 0; i < k; i++) {
      expect(lastFit.betas[i]).toBeCloseTo(snap.betas[i] ?? 0, 12);
    }
    // Total σ ties.
    expect(decompLast.totalVolatility).toBeCloseTo(decompSnap.totalVolatility, 10);
    // Systematic share ties.
    expect(decompLast.systematicShare).toBeCloseTo(decompSnap.systematicShare, 10);
    // Idio share ties.
    expect(decompLast.idiosyncraticShare).toBeCloseTo(decompSnap.idiosyncraticShare, 10);
  });
});
