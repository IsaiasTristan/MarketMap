/**
 * factor-attribution-log-identity — Path B lock unit test.
 *
 * The simple-return cumulative attribution identity
 *   Σ y_t  ≡  Σ(β_t·r_t) + Σα_t + Σε_t
 * holds at the daily level but the LHS is NOT a compounded total
 * return. The log-return path replaces all daily series with their
 * log transforms so the per-day identity remains exact AND
 *   exp(Σ y_log_t) − 1  ≡  Π(1 + r_simple_t) − 1
 * (i.e. the cumulative log sum reconciles to the compounded geometric
 * realised return). This file pins both invariants on synthetic data.
 */
import { describe, it, expect } from "vitest";
import { rollingMultivariateOls } from "../../src/lib/factors/regression/rolling";
import {
  expSumMinus1,
  factorRowLog,
  logOnePlus,
  logOnePlusClipped,
  LOG_ONE_PLUS_CLIP_FLOOR,
  stockExcessLog,
} from "../../src/lib/factors/attribution/log-returns";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

describe("log-return cumulative attribution (Path B identity)", () => {
  it("Σ y_log = Σ(β·x_log) + Σα + Σε post burn-in (synthetic)", () => {
    const r = rng(11);
    const n = 300;
    const W = 60;

    const XSimple: number[][] = Array.from({ length: n }, () => [
      r() * 0.02,
      r() * 0.015,
    ]);
    const ySimple = XSimple.map((row, i) => {
      const b1 = 0.8 + 0.2 * Math.sin(i / 30);
      const b2 = -0.3 + 0.1 * Math.cos(i / 25);
      return 0.0001 + b1 * row[0]! + b2 * row[1]! + r() * 0.005;
    });

    const yLog = ySimple.map((y) => logOnePlus(y));
    const XLog = XSimple.map((row) => factorRowLog(row));
    expect(yLog.every((v) => v != null)).toBe(true);
    expect(XLog.every((row) => row != null)).toBe(true);

    const yLogArr = yLog as number[];
    const XLogArr = XLog as number[][];
    const dates = Array.from(
      { length: n },
      (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    );

    const fits = rollingMultivariateOls(dates, yLogArr, XLogArr, W);
    expect(fits.length).toBe(n - W + 1);

    const startIdx = W - 1;
    let actualSum = 0;
    let factorContribSum = 0;
    let alphaSum = 0;
    let residualSum = 0;

    for (let i = 0; i < fits.length; i++) {
      const t = startIdx + i;
      const fit = fits[i]!.fit;
      expect(fit.failed).toBe(false);
      actualSum += yLogArr[t]!;
      alphaSum += fit.alpha;
      let predT = fit.alpha;
      for (let fi = 0; fi < fit.betas.length; fi++) {
        const contrib = (fit.betas[fi] ?? 0) * (XLogArr[t]?.[fi] ?? 0);
        predT += contrib;
        factorContribSum += contrib;
      }
      residualSum += yLogArr[t]! - predT;
    }

    const gap = actualSum - (factorContribSum + alphaSum + residualSum);
    expect(Math.abs(gap)).toBeLessThan(1e-10);
  });

  it("exp(Σ y_log) − 1 == Π(1 + y_simple) − 1 over the same days", () => {
    const r = rng(23);
    const n = 252;
    const ySimple: number[] = Array.from({ length: n }, () => r() * 0.02);

    const compounded =
      ySimple.reduce((acc, y) => acc * (1 + y), 1) - 1;
    const yLogValues = ySimple.map((y) => logOnePlus(y));
    expect(yLogValues.every((v) => v != null)).toBe(true);
    const sumLog = (yLogValues as number[]).reduce((s, v) => s + v, 0);
    const exp = expSumMinus1(sumLog);
    expect(Math.abs(exp - compounded)).toBeLessThan(1e-12);
  });

  it("strict drop policy: 1 + r ≤ 0 on any factor flips factorRowLog to null", () => {
    expect(logOnePlus(-1)).toBeNull();
    expect(logOnePlus(-1.5)).toBeNull();
    expect(factorRowLog([0.01, -1.2])).toBeNull();
    expect(stockExcessLog(-1.1, 0.0001)).toBeNull();
    expect(stockExcessLog(0.01, -2)).toBeNull();
    expect(logOnePlus(0)).toBe(0);
  });

  it("logOnePlusClipped returns ln(1+x) cleanly when above the floor", () => {
    const r = logOnePlusClipped(0.05);
    expect(r.clipped).toBe(false);
    expect(Math.abs(r.value - Math.log(1.05))).toBeLessThan(1e-15);
  });

  it("logOnePlusClipped clips and flags when 1+x falls below the floor", () => {
    // Daily simple return below -99.9999% would push 1+x under the floor
    // (e.g. delisting at zero or worse).
    const r = logOnePlusClipped(-1);
    expect(r.clipped).toBe(true);
    expect(Math.abs(r.value - Math.log(LOG_ONE_PLUS_CLIP_FLOOR))).toBeLessThan(1e-15);
  });

  it("logOnePlusClipped returns NaN for non-finite input without clipping", () => {
    const r = logOnePlusClipped(Number.NaN);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.clipped).toBe(false);
  });

  it("excess log identity: ln(1+r_stock) − ln(1+r_f) matches stockExcessLog", () => {
    const cases: [number, number][] = [
      [0.012, 0.0001],
      [-0.008, 0.0002],
      [0.0, 0.0],
      [0.05, -0.0005],
    ];
    for (const [rStock, rF] of cases) {
      const expected = Math.log(1 + rStock) - Math.log(1 + rF);
      const actual = stockExcessLog(rStock, rF);
      expect(actual).not.toBeNull();
      expect(Math.abs((actual as number) - expected)).toBeLessThan(1e-15);
    }
  });
});
