/**
 * Tests for buildRollingBetaSeries — the rolling factor-beta series that powers
 * the "Rolling Factor Betas" chart. Pins that failed fits are skipped, betas
 * map onto factor codes in model order, and the output matches the legacy
 * history shape consumed by TimeSeriesPanel.
 */
import { describe, it, expect } from "vitest";
import { buildRollingBetaSeries } from "../../src/lib/factors/regression/rolling-beta-series";
import type { FactorEngineResult, RegressionFit, RollingFitPoint } from "../../src/types/factors";

function fit(betas: number[], alpha: number, rSquared: number, failed = false): RegressionFit {
  return {
    betas,
    alpha,
    residuals: [],
    rSquared,
    adjRSquared: rSquared,
    tStats: betas.map(() => 1),
    stdErrors: betas.map(() => 0.1),
    alphaTStat: 1,
    alphaStdError: 0.1,
    n: 60,
    k: betas.length,
    regularized: false,
    failed,
  };
}

function engineWith(rollingFits: RollingFitPoint[]): FactorEngineResult {
  // Only `factors` + `rollingFits` are read by the builder; the rest is filler.
  return {
    dates: [],
    portExcessReturns: [],
    portTotalReturns: [],
    factorReturns: {},
    rfReturns: [],
    endFit: fit([0, 0], 0, 0),
    rollingFits,
    risk: {} as FactorEngineResult["risk"],
    holdingsImplied: null,
    model: "MACRO14",
    factors: ["EQ", "RATES"],
    normalization: {} as FactorEngineResult["normalization"],
    portExcessLogReturns: null,
    factorLogReturns: null,
    rfLogReturns: null,
    endFitLog: null,
    rollingFitsLog: null,
    windowFallback: null,
    coverage: {
      totalPositions: 0,
      seriesStart: null,
      seriesEnd: null,
      alignedDates: 0,
      shortHistoryPositions: [],
      excludedPositions: [],
      droppedLowCoverageDates: 0,
    },
    windowCoverage: {
      totalPositions: 0,
      seriesStart: null,
      seriesEnd: null,
      alignedDates: 0,
      shortHistoryPositions: [],
      excludedPositions: [],
      droppedLowCoverageDates: 0,
    },
  };
}

describe("buildRollingBetaSeries (rolling-beta-series)", () => {
  it("maps betas onto factor codes in model order, one point per fit", () => {
    const engine = engineWith([
      { date: "2024-01-02", fit: fit([0.9, -0.2], 0.001, 0.8) },
      { date: "2024-01-03", fit: fit([1.1, -0.1], 0.002, 0.82) },
    ]);

    const out = buildRollingBetaSeries(engine);

    expect(out.dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(out.series.EQ).toEqual([0.9, 1.1]);
    expect(out.series.RATES).toEqual([-0.2, -0.1]);
    expect(out.alphas).toEqual([0.001, 0.002]);
    expect(out.rSquareds).toEqual([0.8, 0.82]);
    expect(out.asOfDate).toBe("2024-01-03");
  });

  it("skips failed fits entirely (not zero-filled)", () => {
    const engine = engineWith([
      { date: "2024-01-02", fit: fit([0.9, -0.2], 0.001, 0.8) },
      { date: "2024-01-03", fit: fit([0, 0], 0, 0, true) },
      { date: "2024-01-04", fit: fit([1.0, -0.15], 0.0015, 0.79) },
    ]);

    const out = buildRollingBetaSeries(engine);

    expect(out.dates).toEqual(["2024-01-02", "2024-01-04"]);
    expect(out.series.EQ).toEqual([0.9, 1.0]);
    expect(out.series.RATES).toHaveLength(2);
  });

  it("returns the legacy history shape with empty arrays when there are no fits", () => {
    const out = buildRollingBetaSeries(engineWith([]));

    expect(out.dates).toEqual([]);
    expect(out.series).toEqual({ EQ: [], RATES: [] });
    expect(out.alphas).toEqual([]);
    expect(out.rSquareds).toEqual([]);
    expect(out.asOfDate).toBeNull();
  });
});
