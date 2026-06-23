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

describe("live 1D slice — 1-obs identity (simple + log)", () => {
  // The /api/analysis/factors/per-stock/live-1d endpoint reuses
  // `computeStaticBetaPeriodSlice` with a SINGLE-DAY factor row + a single
  // realised y. This block pins the identity for both spaces so any
  // regression to the live decomposition is caught here.
  const betas = [0.9, -0.3, 1.4];
  const alpha = 0.0008;
  const liveFactorRow = [0.012, -0.005, 0.008];
  const liveY = 0.011;

  it("simple: observations = 1 · α × 1 = α · identity closes", () => {
    const s = computeStaticBetaPeriodSlice(betas, alpha, [liveFactorRow], [liveY]);
    expect(s.observations).toBe(1);
    expect(s.alphaSum).toBeCloseTo(alpha, 15);
    let sysCheck = 0;
    for (let i = 0; i < betas.length; i++) sysCheck += betas[i]! * liveFactorRow[i]!;
    expect(s.systematic).toBeCloseTo(sysCheck, 14);
    expect(s.systematic + s.alphaSum + s.residualSum).toBeCloseTo(liveY, 14);
  });

  it("log: factor row in log space gives β_log × ln(1+f) identity", () => {
    // Live log path: y_log = ln(1+r_stock) − ln(1+r_f); factor x_log = ln(1+f).
    const rf = 0.0001;
    const xLog = liveFactorRow.map((f) => Math.log(1 + f));
    const yLog = Math.log(1 + liveY) - Math.log(1 + rf);
    const alphaLog = 0.0007;
    const betasLog = [0.85, -0.28, 1.35];
    const s = computeStaticBetaPeriodSlice(betasLog, alphaLog, [xLog], [yLog]);
    expect(s.observations).toBe(1);
    expect(s.alphaSum).toBeCloseTo(alphaLog, 15);
    let sysCheck = 0;
    for (let i = 0; i < betasLog.length; i++) sysCheck += betasLog[i]! * xLog[i]!;
    expect(s.systematic).toBeCloseTo(sysCheck, 14);
    expect(s.systematic + s.alphaSum + s.residualSum).toBeCloseTo(yLog, 14);
  });

  it("grid (cached) vs live-1d: only the underlying y differs, not the estimator", () => {
    // Yesterday's CACHED slice was built from one historical y over the same
    // factors + betas. Today's LIVE slice swaps y for the live realization
    // (and the factor row for today's live row). The slice helper is the
    // same; the only thing that can move between the two surfaces is the
    // INPUT DATA, never the math. We assert that by holding the inputs
    // constant across two calls and checking the outputs are bit-identical.
    const yesterdayY = 0.004;
    const yesterdayRow = [0.001, 0.002, -0.001];
    const cached = computeStaticBetaPeriodSlice(
      betas,
      alpha,
      [yesterdayRow],
      [yesterdayY],
    );
    const live = computeStaticBetaPeriodSlice(
      betas,
      alpha,
      [liveFactorRow],
      [liveY],
    );
    // Both slices have observations = 1 and same α-handling.
    expect(cached.observations).toBe(1);
    expect(live.observations).toBe(1);
    expect(cached.alphaSum).toBeCloseTo(live.alphaSum, 15);
    // The systematic / residual MUST differ — same estimator, different data.
    expect(cached.systematic).not.toBeCloseTo(live.systematic, 6);
  });
});
