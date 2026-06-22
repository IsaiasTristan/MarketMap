/**
 * Static-horizon-beta period decomposition (2026-06-21).
 *
 * Pins the contract that makes the per-stock GRID and the per-stock WATERFALL
 * show the same numbers:
 *   • the period identity Σy = Σ(β·Σr) + α·obs + residual holds exactly, and
 *   • the grid readers (factorCellValue / summaryColumnValue) and the
 *     waterfall both reconstruct that identity from the SAME slice, so the two
 *     surfaces tie by construction in both simple and log attribution modes.
 */
import { describe, it, expect } from "vitest";
import { computeStaticBetaPeriodSlice } from "../../src/lib/factors/attribution/static-beta-period";
import {
  factorCellValue,
  summaryColumnValue,
} from "../../src/lib/factors/screener/stats";
import type {
  PerStockFactorCell,
  PerStockRow,
} from "../../src/server/services/factor-per-stock.service";
import type { FactorCode } from "../../src/types/factors";

const TOL = 1e-12;

describe("computeStaticBetaPeriodSlice", () => {
  const betas = [1.2, -0.4, 0.7];
  const alpha = 0.0003;
  // 40 days × 3 factors of arbitrary returns.
  const obs = 40;
  const factorRows: number[][] = [];
  const y: number[] = [];
  for (let t = 0; t < obs; t++) {
    factorRows.push([
      0.01 * Math.sin(t),
      0.008 * Math.cos(t * 0.7),
      0.005 * Math.sin(t * 1.3 + 1),
    ]);
    // arbitrary realized excess — NOT constructed from the betas, so the
    // residual is genuinely non-zero.
    y.push(0.002 * Math.sin(t * 0.5) + 0.001 * t * 1e-2);
  }

  const res = computeStaticBetaPeriodSlice(betas, alpha, factorRows, y);

  it("returnByFactor[f] = β_f × Σ_t r_{t,f}", () => {
    for (let fi = 0; fi < betas.length; fi++) {
      let sumR = 0;
      for (const row of factorRows) sumR += row[fi]!;
      expect(res.returnByFactor[fi]!).toBeCloseTo(betas[fi]! * sumR, 12);
    }
  });

  it("alphaSum = α × observations", () => {
    expect(res.alphaSum).toBeCloseTo(alpha * obs, 15);
    expect(res.observations).toBe(obs);
  });

  it("identity Σy = systematic + alphaSum + residualSum closes exactly", () => {
    let sumY = 0;
    for (const v of y) sumY += v;
    expect(res.systematic + res.alphaSum + res.residualSum).toBeCloseTo(sumY, 12);
  });

  it("residual is ~0 when y is exactly the static-beta prediction", () => {
    const yExact = factorRows.map((row) => {
      let pred = alpha;
      for (let fi = 0; fi < betas.length; fi++) pred += betas[fi]! * row[fi]!;
      return pred;
    });
    const exact = computeStaticBetaPeriodSlice(betas, alpha, factorRows, yExact);
    expect(Math.abs(exact.residualSum)).toBeLessThan(TOL);
  });

  it("empty slice yields zero sums", () => {
    const empty = computeStaticBetaPeriodSlice(betas, alpha, [], []);
    expect(empty.observations).toBe(0);
    expect(empty.alphaSum).toBe(0);
    expect(empty.residualSum).toBe(0);
    expect(empty.systematic).toBe(0);
  });
});

describe("grid == waterfall (static-beta slice, both modes)", () => {
  const factors = ["EQ", "MOM", "VAL"] as FactorCode[];

  // Build a slice for one synthetic stock (as the service would emit it),
  // distinct in simple vs log space so a mode bug would be caught.
  function buildSlice(scale: number) {
    const betas = [1.1, -0.3, 0.5];
    const alpha = 0.0002 * scale;
    const obs = 25;
    const rows: number[][] = [];
    const y: number[] = [];
    for (let t = 0; t < obs; t++) {
      rows.push([
        0.012 * scale * Math.sin(t),
        0.006 * scale * Math.cos(t),
        0.004 * scale * Math.sin(t + 2),
      ]);
      y.push(0.0015 * scale * Math.sin(t * 0.4) + 0.0007 * scale);
    }
    return computeStaticBetaPeriodSlice(betas, alpha, rows, y);
  }

  // Simple space and log space deliberately differ (scale 1 vs 0.9).
  const simple = buildSlice(1);
  const log = buildSlice(0.9);

  // Period slice the service stores on the row.
  const returnByFactor: Partial<Record<FactorCode, number>> = {};
  const returnByFactorLog: Partial<Record<FactorCode, number>> = {};
  factors.forEach((c, fi) => {
    returnByFactor[c] = simple.returnByFactor[fi]!;
    returnByFactorLog[c] = log.returnByFactor[fi]!;
  });

  // The per-stock route's applyPeriodOverlay copies the slice onto the row's
  // grid-display fields. Replicate that here so we assert the readers tie.
  const cells: Partial<Record<FactorCode, PerStockFactorCell>> = {};
  factors.forEach((c, fi) => {
    cells[c] = {
      beta: 0,
      tStat: 0,
      returnContribution: simple.returnByFactor[fi]!,
      returnContributionLog: log.returnByFactor[fi]!,
      returnContributionGeometric: 0,
      riskContribution: 0,
    } as PerStockFactorCell;
  });

  const row = {
    cells,
    rollingAlphaPostBurnSum: simple.alphaSum,
    rollingResidualPostBurnSum: simple.residualSum,
    rollingAlphaPostBurnSumLog: log.alphaSum,
    rollingResidualPostBurnSumLog: log.residualSum,
    rSquared: 0.5,
    realizedAnnualizedVol: 0.3,
    realizedTotalReturn: 0.1,
  } as unknown as PerStockRow;

  it("simple mode: Σ grid factor cells + alpha + residual = Σy (waterfall total)", () => {
    let sumFactors = 0;
    for (const c of factors) sumFactors += factorCellValue(row.cells[c], "return", "simple")!;
    const alpha = summaryColumnValue(row, "alpha", "simple")!;
    const residual = summaryColumnValue(row, "residual", "simple")!;
    const waterfallTotal = simple.systematic + simple.alphaSum + simple.residualSum;
    expect(sumFactors + alpha + residual).toBeCloseTo(waterfallTotal, 12);
  });

  it("log mode: Σ grid factor cells + alpha + residual = Σy (waterfall total)", () => {
    let sumFactors = 0;
    for (const c of factors) sumFactors += factorCellValue(row.cells[c], "return", "log")!;
    const alpha = summaryColumnValue(row, "alpha", "log")!;
    const residual = summaryColumnValue(row, "residual", "log")!;
    const waterfallTotal = log.systematic + log.alphaSum + log.residualSum;
    expect(sumFactors + alpha + residual).toBeCloseTo(waterfallTotal, 12);
  });

  it("grid alpha is mode-routed (log ≠ simple here)", () => {
    expect(summaryColumnValue(row, "alpha", "log")).toBeCloseTo(log.alphaSum, 15);
    expect(summaryColumnValue(row, "alpha", "simple")).toBeCloseTo(simple.alphaSum, 15);
    expect(summaryColumnValue(row, "alpha", "log")).not.toBeCloseTo(
      summaryColumnValue(row, "alpha", "simple")!,
      6,
    );
  });

  it("grid factor cell is mode-routed (returns the log contribution in log mode)", () => {
    expect(factorCellValue(row.cells.EQ, "return", "log")).toBeCloseTo(
      returnByFactorLog.EQ!,
      15,
    );
    expect(factorCellValue(row.cells.EQ, "return", "simple")).toBeCloseTo(
      returnByFactor.EQ!,
      15,
    );
  });
});
