/**
 * factor-per-stock.service — runs the regression engine separately for every
 * active universe constituent and returns a stock-by-factor grid of beta /
 * return contribution / risk contribution values.
 *
 * Used by the Per-Stock view of the Factors tab. Operates over the *single*
 * universe (single-universe screener — see AGENTS.md) and only includes
 * securities whose `Security.isActive = true` per the locked-in design.
 *
 * Methodology decisions (locked-in 2026-04-25, see plan Phase 2):
 *   • Σ (factor covariance) is recomputed PER STOCK on the regression-aligned
 *     date sample so the Euler decomposition matches the regression's
 *     information set. The legacy full-window Σ result is also exposed for
 *     reconciliation (`systematicShareEulerFullWindow`).
 *   • Total volatility headline is anchored to the realised sample σ of the
 *     stock over the regression-aligned dates (annualised), with the
 *     model-implied √(βΣβ + σ²_idio) reported as reconciliation.
 *   • Return contribution per (stock, factor) is computed as
 *         RC_arith_f = β_f × Σ_t r_{t,f}        (additive, daily-summed)
 *     to be consistent with the rolling-additive series shown in the
 *     time-series chart (`PerStockTimeSeries`). The legacy geometric
 *     definition (`returnContributionGeometric = β_f × (Π(1+r) − 1)`) is
 *     kept for transparency and reconciliation.
 *   • Annualisation: every variance term is multiplied by 252 once at
 *     decomposition time. α (daily intercept) is annualised as α × 252. σ
 *     (daily) is annualised as σ × √252. See AGENTS.md → "annualisation
 *     audit (2026-04-25)" for the canonical table.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { multivariateOls } from "@/lib/factors/regression/ols";
import { rollingMultivariateOls } from "@/lib/factors/regression/rolling";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "@/lib/factors/risk/decomposition";
import { computeFactorCoverage } from "@/lib/factors/regression/coverage";
import { resolveModel, minObservations } from "@/lib/factors/definitions/model-presets";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { multicollinearityReport } from "@/lib/factors/market/multicollinearity";
import { pearsonCorr } from "@/domain/calculations/beta";
import type {
  FactorCode,
  FactorCoverage,
  ModelPresetName,
  RegressionFit,
} from "@/types/factors";

const TRADING_DAYS = 252;
// Minimum daily observations required for a stock to be included at all.
const MIN_PRICE_HISTORY = 30;
/**
 * Rolling window (in trading days) used to compute the per-row Σα / Σε
 * summary columns surfaced by the per-stock grid. Matches the chart's
 * default rolling W (`factorTsRollingWindow: 60` in the analysis store)
 * so the grid number lines up with the waterfall residual when a user
 * opens the per-stock detail panel without changing the rolling selector.
 */
const GRID_ROLLING_WINDOW = 60;

export interface PerStockFactorCell {
  /** OLS beta of this stock to this factor. */
  beta: number;
  tStat: number;
  /**
   * Return contribution: β × Σ_t r_{t,f} (additive, daily-summed).
   * Decimal (0.05 = 5%). Matches the rolling additive series in the
   * per-stock time series chart by construction.
   */
  returnContribution: number;
  /**
   * Legacy geometric variant: β × (Π(1+r_t) − 1). Kept so we can show the
   * gap between additive and compound interpretations in tooltips.
   */
  returnContributionGeometric: number;
  /**
   * Risk (variance) contribution: pct of stock's total variance attributable
   * to this factor — Euler decomposition with Σ recomputed on the stock's
   * regression-aligned dates. Decimal in [-1, 1].
   */
  riskContribution: number;
  /**
   * Top covarying factors in the aligned-Σ ordered by |contribution to (Σβ)_f|.
   * Used by the UI to explain negative `riskContribution` values: a
   * factor's PCR can be negative when its β is small but it has strong
   * negative covariance with another high-β factor.
   */
  topCovariers?: { code: FactorCode; cov: number }[];
}

export interface PerStockRow {
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
  /** Per-factor cells. Missing entries indicate the factor was dropped from
   *  this stock's regression (insufficient overlap or data) — UI badges them. */
  cells: Partial<Record<FactorCode, PerStockFactorCell>>;

  // ----- Fit diagnostics --------------------------------------------------
  rSquared: number;
  alphaAnnualized: number;
  alphaTStat: number;
  /** Σ_t α (daily intercept × n) over the regression-aligned dates. */
  alphaWindowSum: number;
  /** Σ_t ε_t over the regression-aligned dates (≈ 0 by OLS normal eqs). */
  residualWindowSum: number;
  observations: number;

  // ----- Volatility headlines --------------------------------------------
  /**
   * Realized annualised σ of the stock's excess return over the
   * regression-aligned sample. This is the *primary* total volatility
   * headline (per Phase 2 lock-in: anchor to realised, model implied for
   * reconciliation).
   */
  realizedAnnualizedVol: number;
  /**
   * Model-implied annualised σ = √(β'Σβ + σ²_idio) using ALIGNED Σ.
   * Equal to legacy `totalVolatility` only if Σ aligned == Σ full window.
   */
  modelImpliedAnnualizedVol: number;
  /**
   * (model_var − realized_var) / realized_var. Positive = model overstates
   * total risk vs realised; negative = model understates (alpha residual
   * variance not captured by σ²_idio sample). Reported in tooltip.
   */
  varGapPct: number;
  /** Legacy field — equal to `modelImpliedAnnualizedVol` for compatibility. */
  totalVolatility: number;

  // ----- Systematic share (two readings) ---------------------------------
  /**
   * Variance share explained by the factor model under Euler decomposition
   * with Σ recomputed on the stock's regression-aligned dates. THIS is the
   * primary "systematic share" for Phase 2.
   */
  systematicShareEulerAligned: number;
  /**
   * Same Euler decomposition but using Σ from the FULL aligned-window
   * factor sample (legacy). Reported for transparency.
   */
  systematicShareEulerFullWindow: number;
  /** aligned − full window. */
  systematicShareDelta: number;
  /** Legacy field name — equal to `systematicShareEulerAligned`. */
  systematicShare: number;
  /** 1 − systematicShareEulerAligned. */
  idiosyncraticShare: number;

  // ----- Audit / diagnostics ---------------------------------------------
  /**
   * Number of (date, factor) cells in the stock's aligned X matrix that
   * were imputed via `?? 0` because no factor row existed for that date.
   * STRICT DROP-ROW policy (Phase 3): always 0 — kept for backward
   * compatibility with the UI tooltip that watches for zero-fills.
   */
  zeroFillCount: number;
  /** Number of rows with at least one zero-filled factor cell (STRICT DROP-ROW: always 0). */
  zeroFillRowCount: number;
  /**
   * Trading days that were dropped from this stock's regression because
   * one or more factor returns were missing on that date. Phase 3 lock-in
   * (Q3): no silent zero-fill — missing factor cells cause the entire
   * row to be dropped. UI shows a banner when this list is non-empty.
   */
  droppedDates: { date: string; factor: FactorCode }[];

  // ----- Multicollinearity diagnostics (Phase 3, per-stock κ + VIF) -----
  /**
   * Variance Inflation Factor per usable factor (same order as
   * `usableFactors`). `VIF_j = (R⁻¹)_jj` where R is the factor correlation
   * matrix on the regression-aligned sample. UI tints amber ≥ 5, red ≥ 10.
   */
  vif: number[];
  /**
   * Condition number κ = √(λmax/λmin) of the factor correlation matrix on
   * the regression-aligned sample. UI tints amber ≥ 30, red ≥ 100.
   */
  conditionNumber: number;

  // ----- Rolling-OLS summary (grid columns, 2026-04-26) -------------------
  /**
   * Σ α_t over post burn-in from a fixed-W rolling OLS over the
   * regression-aligned sample. W = `gridRollingWindow` on `PerStockResult`
   * (currently 60d, matching the per-stock chart default). null when the
   * sample is too short for any rolling fit. Surfaced in the per-stock grid
   * as the "Alpha" column.
   */
  rollingAlphaPostBurnSum: number | null;
  /**
   * Σ ε_t = Σ (y_t − predicted_t) over post burn-in from the same fixed-W
   * rolling OLS. Matches the "Unexplained Residual" segment in the per-stock
   * detail waterfall whenever the chart's rolling W = `gridRollingWindow`.
   * null when the sample is too short for any rolling fit.
   */
  rollingResidualPostBurnSum: number | null;
  /** Count of valid (non-failed, non-burn-in) rolling fits summed. */
  rollingObservationsPostBurn: number;
}

export interface PerStockResult {
  asOfDate: string;
  model: ModelPresetName;
  /**
   * Number of trading days in the aligned regression window — i.e. the
   * count of dates that pass coverage for *all* `usableFactors`. Despite
   * the name, this is NOT the rolling regression window length the user
   * picked in the UI. Use {@link regressionWindow} for that.
   */
  windowUsed: number;
  /**
   * The regression window length the user requested (in trading days).
   * Distinct from {@link windowUsed} (which is the count of available
   * aligned dates). Downstream callers — notably the per-stock timeseries
   * service — MUST use this field to size the rolling window so the
   * snapshot/rolling Q1 lock-in tie-out holds.
   */
  regressionWindow: number;
  /** Factor coverage for the chosen window. */
  coverage: FactorCoverage[];
  /** Factors actually included in regressions for this run. */
  usableFactors: FactorCode[];
  rows: PerStockRow[];
  /** Tickers that were skipped (e.g. < MIN_PRICE_HISTORY trading days). */
  skipped: { ticker: string; reason: string }[];
  /**
   * Aggregate zero-fill audit across all stocks: total cells imputed with
   * `?? 0` in the regression matrices vs total cells used. ~ 0 expected.
   */
  zeroFillAudit: { totalImputed: number; totalCells: number };
  /**
   * Rolling window (trading days) used to compute the per-row
   * `rollingAlphaPostBurnSum` / `rollingResidualPostBurnSum` summary
   * columns. Constant per response so the grid stays stable across user
   * interactions; defaults to 60d (matches the chart's default rolling W).
   */
  gridRollingWindow: number;
}

interface PerStockParams {
  model: ModelPresetName;
  /** Regression window in trading days. */
  window: number;
  /** Optional sector filter (case-insensitive). */
  sector?: string | null;
  /** Optional sub-theme filter (case-insensitive). */
  subTheme?: string | null;
}

/** Load every active UniverseConstituent with sector/sub-theme metadata. */
async function loadActiveConstituents(opts: { sector?: string | null; subTheme?: string | null }) {
  const rows = await db.universeConstituent.findMany({
    include: { security: true },
    orderBy: [{ sector: "asc" }, { subTheme: "asc" }, { sortOrder: "asc" }],
  });
  return rows.filter((r) => {
    if (!r.security.isActive) return false;
    if (opts.sector && r.sector.toLowerCase() !== opts.sector.toLowerCase()) return false;
    if (opts.subTheme && r.subTheme.toLowerCase() !== opts.subTheme.toLowerCase()) return false;
    return true;
  });
}

/**
 * Build factor return data structures from FactorReturnDaily for a window.
 */
async function loadFactorMatrix(factorCodes: FactorCode[]) {
  const rows = await db.factorReturnDaily.findMany({
    where: { factorCode: { in: [...factorCodes, "RF"] } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, factorCode: true, value: true },
  });

  const factorByDate = new Map<string, Record<string, number>>();
  const rfByDate = new Map<string, number>();
  const perFactorByDate = new Map<FactorCode, Map<string, number>>();
  const allDatesSet = new Set<string>();

  for (const row of rows) {
    const d = row.tradeDate.toISOString().slice(0, 10);
    allDatesSet.add(d);
    if (row.factorCode === "RF") {
      rfByDate.set(d, Number(row.value) / TRADING_DAYS);
      continue;
    }
    if (!factorByDate.has(d)) factorByDate.set(d, {});
    factorByDate.get(d)![row.factorCode] = Number(row.value);
    if (!perFactorByDate.has(row.factorCode as FactorCode)) {
      perFactorByDate.set(row.factorCode as FactorCode, new Map());
    }
    perFactorByDate.get(row.factorCode as FactorCode)!.set(d, Number(row.value));
  }

  const allDates = [...allDatesSet].sort();
  return { factorByDate, rfByDate, allDates, perFactorByDate };
}

/** Realised annualised σ of a daily series (Bessel-corrected). */
function realizedAnnualVol(daily: number[]): number {
  const n = daily.length;
  if (n < 2) return 0;
  const mean = daily.reduce((s, v) => s + v, 0) / n;
  const variance = daily.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

/** Top-3 covarying factors for factor f given annualised covariance matrix. */
function topCovariers(
  fIndex: number,
  factorCodes: FactorCode[],
  covMatrix: number[][],
  betas: number[],
  topN = 3,
): { code: FactorCode; cov: number }[] {
  const k = factorCodes.length;
  const out: { code: FactorCode; cov: number }[] = [];
  for (let j = 0; j < k; j++) {
    if (j === fIndex) continue;
    const cij = covMatrix[fIndex]?.[j] ?? 0;
    out.push({
      code: factorCodes[j]!,
      // contribution to (Σβ)_f from factor j = Σ_{f,j} × β_j
      cov: cij * (betas[j] ?? 0),
    });
  }
  out.sort((a, b) => Math.abs(b.cov) - Math.abs(a.cov));
  return out.slice(0, topN);
}

export async function runPerStockFactors(
  params: PerStockParams,
): Promise<PerStockResult | null> {
  const preset = resolveModel(params.model);
  const requestedFactors = preset.factors as FactorCode[];

  const { factorByDate, rfByDate, allDates, perFactorByDate } =
    await loadFactorMatrix(requestedFactors);
  if (allDates.length === 0) return null;

  const coverageResult = computeFactorCoverage({
    factorCodes: requestedFactors,
    dates: allDates,
    perFactorByDate,
    window: params.window,
  });

  const { usableFactors, coverage, alignedWindowDates } = coverageResult;
  if (usableFactors.length === 0 || alignedWindowDates.length < MIN_PRICE_HISTORY) {
    return {
      asOfDate: allDates[allDates.length - 1] ?? new Date().toISOString().slice(0, 10),
      model: params.model,
      windowUsed: alignedWindowDates.length,
      regressionWindow: params.window,
      coverage,
      usableFactors,
      rows: [],
      skipped: [],
      zeroFillAudit: { totalImputed: 0, totalCells: 0 },
      gridRollingWindow: GRID_ROLLING_WINDOW,
    };
  }

  // Pre-compute the factor matrix and full-window Σ for the aligned window
  // (used as the "legacy" reference per Phase 2 lock-in).
  const factorMatrix: number[][] = alignedWindowDates.map((d) => {
    const day = factorByDate.get(d)!;
    return usableFactors.map((c) => day[c] ?? 0);
  });
  const rfWindow: number[] = alignedWindowDates.map((d) => rfByDate.get(d) ?? 0);

  const factorSeriesColsFull = usableFactors.map((_, fi) =>
    factorMatrix.map((row) => row[fi]!),
  );
  const covMatrixFullWindow = factorCovarianceMatrix(factorSeriesColsFull, null, true);
  const minObs = minObservations(usableFactors.length);

  // Cumulative (geometric) factor returns over the full aligned window —
  // kept for the "legacy geometric" return contribution in each cell.
  const factorCumReturnsGeom: number[] = usableFactors.map((_, fi) => {
    let prod = 1;
    for (const row of factorMatrix) prod *= 1 + (row[fi] ?? 0);
    return prod - 1;
  });

  const constituents = await loadActiveConstituents({
    sector: params.sector,
    subTheme: params.subTheme,
  });

  if (!constituents.length) {
    return {
      asOfDate: allDates[allDates.length - 1] ?? new Date().toISOString().slice(0, 10),
      model: params.model,
      windowUsed: alignedWindowDates.length,
      regressionWindow: params.window,
      coverage,
      usableFactors,
      rows: [],
      skipped: [],
      zeroFillAudit: { totalImputed: 0, totalCells: 0 },
      gridRollingWindow: GRID_ROLLING_WINDOW,
    };
  }

  const winStart = new Date(alignedWindowDates[0]!);
  const winEnd = new Date(alignedWindowDates[alignedWindowDates.length - 1]!);
  winStart.setUTCDate(winStart.getUTCDate() - 7);

  const secIds = constituents.map((c) => c.securityId);
  const priceRows = await db.priceHistory.findMany({
    where: {
      securityId: { in: secIds },
      tradeDate: { gte: winStart, lte: winEnd },
    },
    orderBy: { tradeDate: "asc" },
    select: { securityId: true, tradeDate: true, adjClose: true },
  });

  const pricesBySecurity = new Map<string, Map<string, number>>();
  for (const r of priceRows) {
    const d = r.tradeDate.toISOString().slice(0, 10);
    if (!pricesBySecurity.has(r.securityId)) pricesBySecurity.set(r.securityId, new Map());
    pricesBySecurity.get(r.securityId)!.set(d, Number(r.adjClose));
  }

  const rows: PerStockRow[] = [];
  const skipped: { ticker: string; reason: string }[] = [];

  // Aggregate zero-fill audit
  let totalImputed = 0;
  let totalCells = 0;

  for (const c of constituents) {
    const ticker = c.security.ticker;
    const priceMap = pricesBySecurity.get(c.securityId);
    if (!priceMap || priceMap.size < MIN_PRICE_HISTORY) {
      skipped.push({ ticker, reason: "INSUFFICIENT_PRICE_HISTORY" });
      continue;
    }

    // STRICT DROP-ROW (Phase 3, Q3 lock): if any factor cell is missing
    // for date d, drop the row entirely and record (date, factor) into
    // `droppedDates`. NEVER impute as 0.
    const aligned: { factorRow: number[]; excessReturn: number }[] = [];
    const droppedDates: { date: string; factor: FactorCode }[] = [];
    for (let i = 0; i < alignedWindowDates.length; i++) {
      const d = alignedWindowDates[i]!;
      const dPrev = i === 0 ? null : alignedWindowDates[i - 1]!;
      const cur = priceMap.get(d);
      let prev: number | undefined;
      if (dPrev != null) {
        prev = priceMap.get(dPrev);
      } else {
        const check = new Date(d);
        for (let lag = 1; lag <= 7 && prev === undefined; lag++) {
          check.setUTCDate(check.getUTCDate() - 1);
          prev = priceMap.get(check.toISOString().slice(0, 10));
        }
      }
      if (cur == null || prev == null || prev <= 0) continue;
      const r = (cur - prev) / prev;
      const excess = r - (rfWindow[i] ?? 0);

      const dayMap = factorByDate.get(d);
      if (!dayMap) {
        for (const code of usableFactors) droppedDates.push({ date: d, factor: code });
        continue;
      }
      const row: number[] = new Array(usableFactors.length);
      let dropRow = false;
      for (let fi = 0; fi < usableFactors.length; fi++) {
        const code = usableFactors[fi]!;
        const v = dayMap[code];
        if (v == null) {
          droppedDates.push({ date: d, factor: code });
          dropRow = true;
          break;
        }
        row[fi] = v;
      }
      if (dropRow) continue;
      aligned.push({ factorRow: row, excessReturn: excess });
    }

    if (aligned.length < minObs) {
      skipped.push({ ticker, reason: "INSUFFICIENT_DOF" });
      continue;
    }

    const y = aligned.map((a) => a.excessReturn);
    const x = aligned.map((a) => a.factorRow);
    const fit: RegressionFit = multivariateOls(y, x);

    // Strict drop-row: zero-fill is now structurally impossible.
    const zeroFillCount = 0;
    const zeroFillRowCount = 0;
    totalCells += aligned.length * usableFactors.length;

    // Idiosyncratic variance per residuals (daily, for risk decomposition).
    const k = usableFactors.length;
    const dof = Math.max(1, fit.residuals.length - k - 1);
    const idioDailyVar =
      fit.residuals.reduce((s, e) => s + e ** 2, 0) / dof;

    // ALIGNED Σ — recompute on the stock's regression-aligned factor rows.
    const factorSeriesColsAligned = usableFactors.map((_, fi) =>
      x.map((row) => row[fi]!),
    );
    const covMatrixAligned = factorCovarianceMatrix(
      factorSeriesColsAligned,
      null,
      true,
    );

    // Per-stock multicollinearity (Phase 3, §2.3). Build the correlation
    // matrix on the SAME aligned sample as the regression so the κ + VIF
    // we surface match the X matrix actually used in OLS.
    const corrMatrixAligned: number[][] = usableFactors.map((_, i) =>
      usableFactors.map((__, j) =>
        i === j ? 1 : pearsonCorr(factorSeriesColsAligned[i]!, factorSeriesColsAligned[j]!),
      ),
    );
    const mc = multicollinearityReport(corrMatrixAligned);

    const decompAligned = computeRiskDecomposition(
      fit.betas,
      covMatrixAligned,
      idioDailyVar,
      usableFactors,
      x.length,
    );
    const decompFullWindow = computeRiskDecomposition(
      fit.betas,
      covMatrixFullWindow,
      idioDailyVar,
      usableFactors,
      alignedWindowDates.length,
    );

    // Cumulative additive factor returns over the stock's aligned window
    // (Σ r_t — matches the rolling-additive series displayed in the chart).
    const factorCumReturnsAdditive: number[] = usableFactors.map((_, fi) => {
      let s = 0;
      for (const row of x) s += row[fi] ?? 0;
      return s;
    });

    // Per-factor cells.
    const cells: Partial<Record<FactorCode, PerStockFactorCell>> = {};
    for (let fi = 0; fi < usableFactors.length; fi++) {
      const code = usableFactors[fi]!;
      const beta = fit.betas[fi] ?? 0;
      const tStat = fit.tStats[fi] ?? 0;
      const returnContribution = beta * (factorCumReturnsAdditive[fi] ?? 0);
      const returnContributionGeometric = beta * (factorCumReturnsGeom[fi] ?? 0);
      const riskContribution = decompAligned.factors[fi]?.pctVarianceContrib ?? 0;
      const cell: PerStockFactorCell = {
        beta,
        tStat,
        returnContribution,
        returnContributionGeometric,
        riskContribution,
      };
      // Provide top covariers only when PCR is negative — that is the case
      // the UI explains via tooltip.
      if (riskContribution < 0) {
        cell.topCovariers = topCovariers(fi, usableFactors, covMatrixAligned, fit.betas);
      }
      cells[code] = cell;
    }

    // Realized vs model implied volatility.
    const realizedVol = realizedAnnualVol(y);
    const modelVol = decompAligned.totalVolatility;
    const realizedVar = realizedVol * realizedVol;
    const modelVar = modelVol * modelVol;
    const varGapPct = realizedVar > 0 ? (modelVar - realizedVar) / realizedVar : 0;

    const alphaWindowSum = fit.alpha * fit.n;
    const residualWindowSum = fit.residuals.reduce((s, e) => s + e, 0);

    // Fixed-W rolling OLS over the same aligned (y, X) so the grid
    // surfaces a stable Σα / Σε that matches the per-stock waterfall when
    // the chart's rolling W = GRID_ROLLING_WINDOW (its default).
    let rollingAlphaPostBurnSum: number | null = null;
    let rollingResidualPostBurnSum: number | null = null;
    let rollingObservationsPostBurn = 0;
    if (aligned.length >= GRID_ROLLING_WINDOW + 1) {
      const dummyDates = aligned.map((_, i) => String(i));
      const rolling = rollingMultivariateOls(dummyDates, y, x, GRID_ROLLING_WINDOW);
      let aSum = 0;
      let eSum = 0;
      let obs = 0;
      for (let r = 0; r < rolling.length; r++) {
        const t = GRID_ROLLING_WINDOW - 1 + r;
        const rfit = rolling[r]!.fit;
        if (rfit.failed) continue;
        const xt = x[t];
        if (!xt) continue;
        let pred = rfit.alpha;
        for (let fi = 0; fi < k; fi++) pred += (rfit.betas[fi] ?? 0) * (xt[fi] ?? 0);
        aSum += rfit.alpha;
        eSum += (y[t] ?? 0) - pred;
        obs++;
      }
      if (obs > 0) {
        rollingAlphaPostBurnSum = aSum;
        rollingResidualPostBurnSum = eSum;
        rollingObservationsPostBurn = obs;
      }
    }

    rows.push({
      ticker,
      name: c.security.name,
      sector: c.sector,
      subTheme: c.subTheme,
      cells,
      rSquared: fit.rSquared,
      alphaAnnualized: fit.alpha * TRADING_DAYS,
      alphaTStat: fit.alphaTStat,
      alphaWindowSum,
      residualWindowSum,
      observations: fit.n,
      realizedAnnualizedVol: realizedVol,
      modelImpliedAnnualizedVol: modelVol,
      varGapPct,
      totalVolatility: modelVol,
      systematicShareEulerAligned: decompAligned.systematicShare,
      systematicShareEulerFullWindow: decompFullWindow.systematicShare,
      systematicShareDelta:
        decompAligned.systematicShare - decompFullWindow.systematicShare,
      systematicShare: decompAligned.systematicShare,
      idiosyncraticShare: decompAligned.idiosyncraticShare,
      zeroFillCount,
      zeroFillRowCount,
      droppedDates,
      vif: mc.vif,
      conditionNumber: mc.conditionNumber,
      rollingAlphaPostBurnSum,
      rollingResidualPostBurnSum,
      rollingObservationsPostBurn,
    });
  }

  rows.sort((a, b) => {
    if (a.sector !== b.sector) return a.sector.localeCompare(b.sector);
    if (a.subTheme !== b.subTheme) return a.subTheme.localeCompare(b.subTheme);
    return a.ticker.localeCompare(b.ticker);
  });

  return {
    asOfDate: alignedWindowDates[alignedWindowDates.length - 1] ?? "",
    model: params.model,
    windowUsed: alignedWindowDates.length,
    regressionWindow: params.window,
    coverage,
    usableFactors,
    rows,
    skipped,
    zeroFillAudit: { totalImputed, totalCells },
    gridRollingWindow: GRID_ROLLING_WINDOW,
  };
}

/** Helper: build a list of {code, label} for the UI. */
export function describeFactors(codes: FactorCode[]): { code: FactorCode; label: string; shortLabel: string }[] {
  return codes.map((c) => {
    const def = getFactorDef(c);
    return { code: c, label: def.label, shortLabel: def.shortLabel };
  });
}
