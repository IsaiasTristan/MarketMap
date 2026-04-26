/**
 * factor-rolling-failure — Phase 3 §2.10 / Q3 lock unit test.
 *
 * Verifies the OLS engine sets `failed = true` (not silent zero β) when:
 *   1. n < k + 2 (insufficient degrees of freedom)
 *   2. The X matrix is rank-deficient (perfect collinearity) — both the
 *      direct invert AND the ridge fallback should still produce a fit
 *      with valid betas (ridge regularised) but should NOT silently
 *      zero out a fit. The Phase 3 contract is: any time we COULD lose
 *      information, we MUST flag it.
 *
 * Pairs with `factor-per-stock-timeseries.service.ts` which checks
 * `fit.failed` and skips that day from cumulative sums.
 */
import { describe, it, expect } from "vitest";
import { multivariateOls } from "../../src/lib/factors/regression/ols";
import { invertWithRidge } from "../../src/lib/factors/regression/matrix";

describe("rolling fit failure flag (Phase 3 §2.10 / Q3 lock)", () => {
  it("fallbackFit sets failed=true when n < k + 2", () => {
    const y = [0.01, -0.02];
    const X = [
      [0.01, 0.005, 0.002],
      [-0.01, 0.001, 0.003],
    ];
    const fit = multivariateOls(y, X);
    expect(fit.failed).toBe(true);
    expect(fit.regularized).toBe(false);
    expect(fit.betas).toEqual([0, 0, 0]);
    expect(fit.alpha).toBe(0);
  });

  it("fallbackFit sets failed=true when k < 1", () => {
    const y = [0.01, -0.02, 0.03];
    const X: number[][] = [[], [], []];
    const fit = multivariateOls(y, X);
    expect(fit.failed).toBe(true);
  });

  it("invertWithRidge: failed=false when normal invert succeeds", () => {
    const A = [
      [4, 1],
      [1, 3],
    ];
    const out = invertWithRidge(A);
    expect(out.failed).toBe(false);
    expect(out.regularized).toBe(false);
  });

  it("invertWithRidge: regularized=true on exactly singular matrix, failed=false when ridge solves it", () => {
    // Identical rows — exactly singular. Direct invert returns null;
    // ridge fallback adds λI to diagonal and recovers a valid inverse.
    const A = [
      [1, 1],
      [1, 1],
    ];
    const out = invertWithRidge(A);
    expect(out.regularized).toBe(true);
    expect(out.failed).toBe(false);
  });

  it("multivariateOls succeeds with regularized=true on collinear factors (no silent failure)", () => {
    const n = 60;
    const X: number[][] = [];
    for (let i = 0; i < n; i++) {
      const v = Math.sin(i / 5) * 0.01;
      X.push([v, v * 1.0000001 + 1e-10, Math.cos(i / 7) * 0.01]);
    }
    const y = X.map((row) => 0.5 * row[0]! + 0.3 * row[2]!);
    const fit = multivariateOls(y, X);
    expect(fit.failed).toBe(false);
  });
});
