/**
 * Unit tests for `factorHorizonMetrics` and `pickFactorMetric`
 * (src/domain/calculations/factor-horizon-metrics.ts). Pure functions, no I/O.
 *
 * Scope:
 *   - Geometric horizon return equals Π(1+r)-1 over the trailing window
 *     (and reconciles with `totalReturnForHorizon`, so factor cells match the
 *     stock Market Map grid by construction).
 *   - Excess return = factor return minus benchmark return over the same horizon.
 *   - 1D volatility/Sharpe are null (single-obs window); multi-day windows
 *     produce finite values.
 *   - Short series (< horizon length) yields null cells.
 *   - `pickFactorMetric` selects the requested scalar per metric.
 */
import { describe, expect, it } from "vitest";
import {
  factorHorizonMetrics,
  pickFactorMetric,
} from "@/domain/calculations/factor-horizon-metrics";
import { totalReturnForHorizon } from "@/domain/calculations/returns";
import { HORIZON_TRADING_DAYS } from "@/domain/entities/horizons";

function compound(values: number[]): number {
  return values.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

function buildSeries(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}

describe("factorHorizonMetrics — geometric return", () => {
  it("matches Π(1+r)-1 over the trailing window for each horizon", () => {
    const series = [0.01, -0.02, 0.005, 0.012, -0.003, 0.008, 0.001];
    const out = factorHorizonMetrics(series, null, 0.04);

    expect(out.D1.return).toBeCloseTo(0.001, 12);
    expect(out.D5.return).toBeCloseTo(compound(series.slice(-5)), 12);
    expect(out.D5.return).toBeCloseTo(
      totalReturnForHorizon(series, "D5") ?? Number.NaN,
      12,
    );
  });

  it("returns null for horizons longer than the available series", () => {
    const series = buildSeries(10, 0.0);
    const out = factorHorizonMetrics(series, null, 0.04);
    expect(out.D1.return).toBe(0);
    expect(out.D5.return).toBe(0);
    expect(out.M1.return).toBeNull();
    expect(out.M3.return).toBeNull();
    expect(out.M6.return).toBeNull();
    expect(out.Y1.return).toBeNull();
  });

  it("returns all-null cells when the factor series is empty", () => {
    const out = factorHorizonMetrics([], null, 0.04);
    for (const h of Object.keys(HORIZON_TRADING_DAYS) as Array<
      keyof typeof HORIZON_TRADING_DAYS
    >) {
      expect(out[h].return).toBeNull();
      expect(out[h].excessReturn).toBeNull();
      expect(out[h].volatility).toBeNull();
      expect(out[h].sharpe).toBeNull();
    }
  });
});

describe("factorHorizonMetrics — excess return", () => {
  it("subtracts the benchmark's compounded horizon return", () => {
    const factor = [0.01, 0.02, -0.005, 0.008, 0.012, 0.003, -0.002];
    const bench = [0.005, 0.01, 0.0, 0.004, 0.006, 0.0015, -0.001];
    const out = factorHorizonMetrics(factor, bench, 0.04);

    const expected5d =
      compound(factor.slice(-5)) - compound(bench.slice(-5));
    expect(out.D5.excessReturn).toBeCloseTo(expected5d, 12);
    expect(out.D1.excessReturn).toBeCloseTo(
      factor[factor.length - 1]! - bench[bench.length - 1]!,
      12,
    );
  });

  it("returns null when benchmark series is null", () => {
    const out = factorHorizonMetrics([0.01, 0.02, 0.03], null, 0.04);
    expect(out.D1.excessReturn).toBeNull();
    expect(out.D5.excessReturn).toBeNull();
  });

  it("returns null when benchmark series is too short for the horizon", () => {
    const factor = buildSeries(60, 0.001);
    const bench = buildSeries(3, 0.0005);
    const out = factorHorizonMetrics(factor, bench, 0.04);
    expect(out.M1.excessReturn).toBeNull();
    expect(out.D5.excessReturn).toBeNull();
    expect(out.D1.excessReturn).not.toBeNull();
  });
});

describe("factorHorizonMetrics — volatility / Sharpe gating", () => {
  it("returns null vol and Sharpe at the 1D horizon (single obs)", () => {
    const series = buildSeries(252, 0.0005);
    const out = factorHorizonMetrics(series, null, 0.04);
    expect(out.D1.volatility).toBeNull();
    expect(out.D1.sharpe).toBeNull();
  });

  it("produces finite vol and Sharpe at multi-day horizons", () => {
    const series = [
      0.01, -0.012, 0.008, -0.007, 0.014, -0.009, 0.011, -0.005, 0.013, -0.011,
      0.007, -0.008, 0.012, -0.013, 0.006, -0.004, 0.015, -0.01, 0.009, -0.006,
      0.011, -0.007, 0.013, -0.012, 0.008, -0.005, 0.014, -0.009, 0.007, -0.008,
    ];
    const out = factorHorizonMetrics(series, null, 0.04);
    expect(out.D5.volatility).not.toBeNull();
    expect(out.D5.volatility).toBeGreaterThan(0);
    expect(out.D5.sharpe).not.toBeNull();
    expect(Number.isFinite(out.D5.sharpe!)).toBe(true);
  });
});

describe("pickFactorMetric", () => {
  it("selects the requested scalar per metric kind", () => {
    const out = factorHorizonMetrics([0.01, 0.02, 0.015], [0.005, 0.01, 0.005], 0.04);
    expect(pickFactorMetric(out, "D1", "RETURN")).toBe(out.D1.return);
    expect(pickFactorMetric(out, "D1", "EXCESS_RETURN")).toBe(out.D1.excessReturn);
    expect(pickFactorMetric(out, "D1", "VOLATILITY")).toBe(out.D1.volatility);
    expect(pickFactorMetric(out, "D1", "SHARPE")).toBe(out.D1.sharpe);
  });
});
