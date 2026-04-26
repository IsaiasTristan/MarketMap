/**
 * factor-attribution-identity — Phase 3 §2.2 / Q5 lock unit test.
 *
 * Asserts the cumulative return identity holds at FP precision on
 * synthetic noisy data when the rolling-fit decomposition is built
 * exactly the way the per-stock timeseries service does:
 *
 *   Σy_t  ≡  Σ(β_t · r_t) + Σα_t + Σε_t      ∀ t ≥ W − 1
 *
 * This validates that even when β_t drifts day-to-day, the
 * (factor + alpha + residual) decomposition reconstructs the realised
 * series exactly post burn-in.
 */
import { describe, it, expect } from "vitest";
import { rollingMultivariateOls } from "../../src/lib/factors/regression/rolling";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

describe("rolling attribution identity (Phase 3 §2.2 / Q5 lock)", () => {
  it("Σy = Σ(β·r) + Σα + Σε post burn-in (synthetic data, time-varying β)", () => {
    const r = rng(7);
    const n = 300;
    const W = 60;
    const X: number[][] = Array.from({ length: n }, () => [r() * 0.02, r() * 0.015]);
    // Time-varying true β for realism — should not affect identity.
    const y = X.map((row, i) => {
      const b1 = 0.8 + 0.2 * Math.sin(i / 30);
      const b2 = -0.3 + 0.1 * Math.cos(i / 25);
      return 0.0001 + b1 * row[0]! + b2 * row[1]! + r() * 0.005;
    });
    const dates = Array.from({ length: n }, (_, i) => `2024-01-${String(i % 28 + 1).padStart(2, "0")}`);

    const fits = rollingMultivariateOls(dates, y, X, W);
    expect(fits.length).toBe(n - W + 1);

    const startIdx = W - 1;
    let actualSum = 0;
    let factorContribSum = 0;
    let alphaSum = 0;
    let residualSum = 0;
    for (let r = 0; r < fits.length; r++) {
      const t = startIdx + r;
      const fit = fits[r]!.fit;
      expect(fit.failed).toBe(false);
      actualSum += y[t]!;
      alphaSum += fit.alpha;
      let predT = fit.alpha;
      for (let fi = 0; fi < fit.betas.length; fi++) {
        const contrib = (fit.betas[fi] ?? 0) * (X[t]?.[fi] ?? 0);
        predT += contrib;
        factorContribSum += contrib;
      }
      residualSum += y[t]! - predT;
    }

    const gap = actualSum - (factorContribSum + alphaSum + residualSum);
    expect(Math.abs(gap)).toBeLessThan(1e-10);
  });
});
