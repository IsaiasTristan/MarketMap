/**
 * factor-display-defaults — pin the headline-picker contract.
 *
 * The per-stock detail panel and the portfolio AttributionClient default to
 * Path B (log-return attribution) whenever the engine emits a non-null log
 * series. The big "Total Excess Return" headline shows the geometric
 * reconciliation `exp(Σ y_log) − 1` so it ties to compounded realised
 * performance over the visible window. When the log path is unavailable
 * (strict drop: any 1+r ≤ 0) the helper falls back to arithmetic Σ y_simple
 * AND signals a banner via `fallbackToSimple`.
 *
 * These tests pin the picker on synthetic inputs:
 *
 *   • Path B picked when logSum is finite and arithmetic Σ y_simple is also
 *     present — headline = exp(Σ log) − 1, NOT the arithmetic sum.
 *   • Path A picked (fallback) when logSum is null OR non-finite — headline
 *     = arithmeticSum, fallbackToSimple = true.
 *   • Geometric reconciliation matches a manually-compounded return chain
 *     (sanity check on the helper's algebra).
 */
import { describe, it, expect } from "vitest";
import { pickHeadlineValue } from "../../src/lib/factors/attribution/headline-picker";

describe("headline picker — log-default contract", () => {
  it("uses log path and returns exp(Σ log) − 1, not arithmetic Σ simple", () => {
    // Realistic INTC-like scenario: arithmetic Σ ≈ +123% but compounded
    // geometric ≈ +302%. The picker must pick the geometric value.
    const arithmeticSum = 1.2252;
    const logSum = Math.log(1 + 3.02);
    const result = pickHeadlineValue({ arithmeticSum, logSum });

    expect(result.useLog).toBe(true);
    expect(result.fallbackToSimple).toBe(false);
    expect(result.geometric).not.toBeNull();
    expect(result.geometric!).toBeCloseTo(3.02, 9);
    expect(result.headlineValue).toBeCloseTo(3.02, 9);
    expect(result.headlineValue).not.toBeCloseTo(arithmeticSum, 2);
    expect(result.arithmetic).toBe(arithmeticSum);
    expect(result.logSum).toBe(logSum);
  });

  it("matches a manually-compounded daily return chain (sanity check)", () => {
    // 252 daily simple excess returns; the picker's geometric should equal
    // Π(1+r) − 1 to floating-point precision.
    const dailyReturns: number[] = [];
    for (let i = 0; i < 252; i++) {
      dailyReturns.push(Math.sin(i / 17) * 0.005 + 0.0006);
    }
    const arithmeticSum = dailyReturns.reduce((a, b) => a + b, 0);
    const logSum = dailyReturns.reduce((a, b) => a + Math.log(1 + b), 0);
    const compounded = dailyReturns.reduce((a, b) => a * (1 + b), 1) - 1;

    const result = pickHeadlineValue({ arithmeticSum, logSum });
    expect(result.useLog).toBe(true);
    expect(result.geometric!).toBeCloseTo(compounded, 12);
    expect(result.headlineValue).toBeCloseTo(compounded, 12);

    // For a generally positive return path, geometric ≥ arithmetic by Jensen.
    expect(result.geometric!).toBeGreaterThan(arithmeticSum);
  });

  it("falls back to arithmetic when logSum is null, sets banner flag", () => {
    const arithmeticSum = -0.1834;
    const result = pickHeadlineValue({ arithmeticSum, logSum: null });

    expect(result.useLog).toBe(false);
    expect(result.fallbackToSimple).toBe(true);
    expect(result.headlineValue).toBe(arithmeticSum);
    expect(result.geometric).toBeNull();
    expect(result.logSum).toBeNull();
    expect(result.arithmetic).toBe(arithmeticSum);
  });

  it("treats non-finite logSum as missing (NaN-safe fallback)", () => {
    const arithmeticSum = 0.42;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = pickHeadlineValue({ arithmeticSum, logSum: bad });
      expect(result.useLog).toBe(false);
      expect(result.fallbackToSimple).toBe(true);
      expect(result.headlineValue).toBe(arithmeticSum);
      expect(result.geometric).toBeNull();
    }
  });

  it("does not flip the sign when geometric and arithmetic disagree", () => {
    // Path with a steep drawdown: arithmetic might flip relative to geometric
    // in pathological cases. Confirm the picker honours its inputs strictly.
    const arithmeticSum = 0.05;
    const logSum = -0.02;
    const result = pickHeadlineValue({ arithmeticSum, logSum });
    expect(result.useLog).toBe(true);
    // exp(-0.02) − 1 ≈ -0.0198 — must NOT silently use the +5% arithmetic.
    expect(result.geometric!).toBeCloseTo(Math.exp(-0.02) - 1, 12);
    expect(result.headlineValue).toBeLessThan(0);
    expect(result.arithmetic).toBeGreaterThan(0);
  });
});

describe("headline picker — surface integration shape", () => {
  it("attribution-client style payload: present cumulativeLog drives geometric headline", () => {
    // Mirrors AttributionClient: when attribution.cumulativeLog has a final
    // point with cumulativePortLogReturn = X, the displayed headline is the
    // pre-computed cumulativePortGeometric (exp(X) − 1). The helper produces
    // the same value the engine ships in cumulativePortGeometric.
    const cumulativePortLogReturn = 0.385;
    const cumulativePortGeometric = Math.exp(cumulativePortLogReturn) - 1;
    const arithmeticSimpleEnd = 0.31;

    const result = pickHeadlineValue({
      arithmeticSum: arithmeticSimpleEnd,
      logSum: cumulativePortLogReturn,
    });
    expect(result.useLog).toBe(true);
    expect(result.headlineValue).toBeCloseTo(cumulativePortGeometric, 12);
  });

  it("per-stock style payload: missing log block triggers strict-drop banner", () => {
    // Mirrors PerStockDetail's behaviour when tsData.log is null. The
    // component reads useLog = data.log != null and feeds logSum: null into
    // the picker, which must emit fallbackToSimple = true so the panel can
    // render its yellow banner.
    const arithmeticSum = 0.0834;
    const result = pickHeadlineValue({ arithmeticSum, logSum: null });
    expect(result.useLog).toBe(false);
    expect(result.fallbackToSimple).toBe(true);
    expect(result.headlineValue).toBe(arithmeticSum);
  });
});

describe("Total ≈ display identity (excess + RF compounding)", () => {
  // Pin the algebraic identity that the per-stock detail panel uses to
  // surface a "Total ≈ +X%" sub-line directly comparable to broker /
  // Google "1Y return" numbers.
  //
  //   Σ y_log               = Σ ln(1 + r_stock) − Σ ln(1 + r_f)
  //   Σ ln(1 + r_stock)     = Σ y_log + Σ ln(1 + r_f)        (server pre-computes this as `sumLogTotalVisible`)
  //   exp(Σ ln(1 + r_stock)) − 1 ≡ Π(1 + r_stock) − 1         (compounded total return — what brokers display)
  //
  // The UI computes `Math.exp(tsData.log.sumLogTotalVisible) − 1` and shows
  // it next to the geometric excess headline.

  it("Total ≈ exp(sumLogTotalVisible) − 1 equals the compounded chain Π(1 + r_stock) − 1", () => {
    const dailyStockReturns: number[] = [];
    const dailyRfDecimal: number[] = [];
    for (let i = 0; i < 252; i++) {
      dailyStockReturns.push(Math.sin(i / 13) * 0.012 + 0.0011);
      dailyRfDecimal.push(0.045 / 252);
    }

    const sumLogExcessVisible = dailyStockReturns.reduce(
      (acc, rStock, i) => acc + Math.log(1 + rStock) - Math.log(1 + dailyRfDecimal[i]!),
      0,
    );
    const sumLogRf = dailyRfDecimal.reduce((a, rf) => a + Math.log(1 + rf), 0);
    const sumLogTotalVisible = sumLogExcessVisible + sumLogRf;

    const totalGeom = Math.exp(sumLogTotalVisible) - 1;
    const compoundedChain =
      dailyStockReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;

    expect(totalGeom).toBeCloseTo(compoundedChain, 12);

    const excessGeom = Math.exp(sumLogExcessVisible) - 1;
    expect(totalGeom).toBeGreaterThan(excessGeom);
    const expectedRfPp =
      dailyRfDecimal.reduce((acc, rf) => acc * (1 + rf), 1) - 1;
    expect((1 + totalGeom) / (1 + excessGeom) - 1).toBeCloseTo(expectedRfPp, 12);
  });

  it("denominator clamp: visibleObs surfaces params.window when N == W (no '252 / 252' truncation)", () => {
    const requestedWindow = 252;
    const visibleObs = 252;
    const denominator = Math.max(visibleObs, requestedWindow);
    expect(denominator).toBe(252);
    expect(visibleObs < denominator).toBe(false);
  });

  it("denominator clamp: surfaces requestedWindow when visibleObs < requestedWindow", () => {
    const requestedWindow = 252;
    const visibleObs = 235;
    const denominator = Math.max(visibleObs, requestedWindow);
    expect(denominator).toBe(252);
    expect(visibleObs < denominator).toBe(true);
    expect(denominator - visibleObs).toBe(17);
  });

  it("denominator clamp: surfaces visibleObs when extended history exceeds requestedWindow", () => {
    const requestedWindow = 252;
    const visibleObs = 270;
    const denominator = Math.max(visibleObs, requestedWindow);
    expect(denominator).toBe(270);
    expect(visibleObs < denominator).toBe(false);
  });
});
