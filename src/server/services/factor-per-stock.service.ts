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
import { normalizeFactorRows } from "@/lib/factors/regression/normalization";
import {
  factorRowLog,
  logOnePlusClipped,
} from "@/lib/factors/attribution/log-returns";
import {
  resolvePeriodSlice,
  type PeriodLabel,
} from "@/lib/factors/attribution/period";
import { computeStaticBetaPeriodSlice } from "@/lib/factors/attribution/static-beta-period";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "@/lib/factors/risk/decomposition";
import { computeFactorCoverage } from "@/lib/factors/regression/coverage";
import { resolveModel, minObservations } from "@/lib/factors/definitions/model-presets";
import { getFactorDef, getFactorInputType } from "@/lib/factors/definitions/factor-codes";
import { multicollinearityReport } from "@/lib/factors/market/multicollinearity";
import { detectFactorStaleness } from "@/lib/factors/diagnostics/freshness";
import { pearsonCorr } from "@/domain/calculations/beta";
import type {
  FactorCode,
  FactorCoverage,
  FactorStalenessEntry,
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
  /**
   * Log-space OLS beta of this stock to this factor — same horizon fit as
   * `beta` but on the log-design matrix (`y_log` regressed on `x_log`).
   * Null when the log path failed for this stock. Persisted so the live 1D
   * decomposition (POST market open) can recompute today's bar in either
   * mode by applying β_log × ln(1 + r_live_factor) without re-running OLS.
   */
  betaLog: number | null;
  tStat: number;
  /**
   * Return contribution (simple space): β_simple × Σ_t r_{t,f} (additive,
   * daily-summed). Decimal (0.05 = 5%). Uses the static horizon-window OLS
   * loading. Shown by the grid when attribution mode = "simple".
   */
  returnContribution: number;
  /**
   * Return contribution (log space): β_log × Σ_t ln(1 + r_{t,f}) using the
   * static horizon-window log-OLS loading. Decimal. Shown by the grid when
   * attribution mode = "log" (the default) so the grid factor column matches
   * the per-stock waterfall's log-space factor bar by construction. Null when
   * the log path failed for this stock (rare — a factor return ≤ -100%).
   */
  returnContributionLog: number | null;
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
  /** Standard error of the daily intercept α from the snapshot OLS. */
  alphaStdError: number;
  /** Standard error of α annualised: alphaStdError × 252 (same scaling as α). */
  alphaStdErrorAnnualized: number;
  /** Half-width of the annualised 95 % CI: 1.96 × alphaStdErrorAnnualized. */
  alphaCi95Half: number;
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
  /**
   * Date-aligned post-burn-in rolling residual stream — only populated when
   * the caller passes `retainResidualStreams: true`. Used by the portfolio
   * residual service to construct ε_p,t = Σ_i w_i · ε_i,t. Excluded from
   * the API response by the per-stock route to keep payloads compact.
   */
  rollingResidualStream?: { dates: string[]; residuals: number[] };
  /**
   * t-statistic for `rollingResidualPostBurnSum`: Σε / (σ_idio × √n_eff).
   * Reads as "is the rolling-OLS residual drift over post burn-in
   * statistically distinct from zero?" σ_idio is the daily SD of the
   * rolling-OLS residual stream itself; n_eff is `rollingObservationsPostBurn`.
   * Null when the rolling sum is null.
   */
  residualTStat: number | null;
  /**
   * 95 % CI half-width for `rollingResidualPostBurnSum`: 1.96 × σ_idio × √n_eff.
   * Pair with the "Unexplained" column to read the band. Null when the
   * rolling sum is null.
   */
  residualCi95Half: number | null;

  // ----- Daily intercepts (persisted for live recompute) -----------------
  /**
   * Raw daily intercept α (simple space) from the horizon OLS — i.e.
   * `alphaAnnualized / 252`. Persisted so the live 1D recompute can apply
   * the intercept directly to a single live day without re-running OLS or
   * rederiving it from the annualised pill.
   */
  alphaDaily: number;
  /**
   * Raw daily intercept α (log space) from the parallel log-OLS. Null when
   * the log path failed. Mirror of `alphaDaily` for log mode.
   */
  alphaDailyLog: number | null;

  // ----- Log-space variants (Attribution mode = "log") -----------------
  // Mirrors of the simple-space fields above, computed by running parallel
  // OLS on log returns (y_log = ln(1+r) − ln(1+rf), x_log = factorRowLog(...)).
  // Null when the log path failed for this stock (rare — happens when a
  // factor return is below −100 % in domain).
  /** Log-space static α annualised: α_log_daily × 252. */
  alphaAnnualizedLog: number | null;
  /** Log-space static α t-stat from snapshot OLS on (y_log, x_log). */
  alphaTStatLog: number | null;
  /** Log-space SE(α) per day. */
  alphaStdErrorLog: number | null;
  /** Log-space annualised CI half: 1.96 × SE(α_log) × 252. */
  alphaCi95HalfLog: number | null;
  /** Σ rolling α_log over post burn-in. exp(this) − 1 ≈ compounded geometric alpha. */
  rollingAlphaPostBurnSumLog: number | null;
  /** Σ rolling ε_log over post burn-in. */
  rollingResidualPostBurnSumLog: number | null;
  /** t-stat on the log-space residual sum, derived from σ of the rolling log-residual stream. */
  residualTStatLog: number | null;
  /** 95 % CI half on log-space Σε. */
  residualCi95HalfLog: number | null;
  /**
   * Date-aligned log-space rolling residual stream — only populated when
   * the caller passes `retainResidualStreams: true`. Used by the portfolio
   * residual service to construct ε_p,t in log space when the user is in
   * log attribution mode. Excluded from the API response by the per-stock
   * route to keep payloads compact.
   */
  rollingResidualStreamLog?: { dates: string[]; residuals: number[] };
  /**
   * Number of days in the per-stock log path where 1 + r fell below the
   * clip floor (LOG_ONE_PLUS_CLIP_FLOOR ≈ 1e-6) and the log was substituted
   * with a clipped value. Surfaced in the cell tooltip when > 0 so the user
   * knows the log-α / log-ε for that stock should be read with caution.
   */
  clippedLogDayCount: number;
  /**
   * Per-attribution-period slices of the Return / Alpha / Unexplained
   * columns. Betas are fit on the full horizon window; these restrict the
   * realized contributions to a trailing reporting period so the grid can
   * follow the Attribution Period control without re-running 400-ticker
   * regressions. Keyed by the same labels as the UI's PeriodSelect.
   */
  periodSlices?: Record<PeriodLabel, PerStockPeriodSlice>;
  /**
   * Realized total return of the stock over the full regression-aligned
   * window: `exp(Σ ln(1 + r_t)) − 1` over the same date sample the
   * regression uses. Pure price quantity (dividend-inclusive via
   * adjClose), independent of betas / alpha / residual — matches the
   * stock price chart's headline over the same date range. Period-level
   * variants live on `periodSlices[label].realizedTotalReturn`. Null
   * when any `1 + r ≤ 0` (strict-drop, consistent with log-path policy).
   */
  realizedTotalReturn: number | null;
}

/**
 * Period-restricted decomposition for a single stock, all derived from the
 * SINGLE static horizon-window OLS fit (betas estimated on the full window,
 * applied across the trailing period). This is the one canonical estimator
 * for per-stock attribution — the grid columns and the per-stock waterfall
 * both read these fields so they tie by construction. (The rolling-60d OLS
 * is demoted to the illustrative beta-drift chart only.)
 *
 * Identity over the slice (simple space):
 *   Σ_{t in period} y_t = Σ_f returnByFactor[f] + alphaSum + residualSum
 * where:
 *   returnByFactor[f] = β_f,simple × Σ_{t in period} r_{t,f}
 *   alphaSum          = α_simple × observations    (static intercept × days)
 *   residualSum       = Σ y_t − Σ_f returnByFactor[f] − alphaSum   (the plug)
 * The log-space variants (returnByFactorLog / alphaSumLog / residualSumLog)
 * use the parallel log-OLS fit and y_log; null when the log path failed.
 */
export interface PerStockPeriodSlice {
  returnByFactor: Partial<Record<FactorCode, number>>;
  /** Log-space factor contributions: β_log × Σ ln(1+r) over the slice. Empty when the log path failed. */
  returnByFactorLog: Partial<Record<FactorCode, number>>;
  alphaSum: number | null;
  residualSum: number | null;
  alphaSumLog: number | null;
  residualSumLog: number | null;
  observations: number;
  startDate: string;
  endDate: string;
  /**
   * Realized total stock return over this period's date range:
   * `exp(Σ ln(1 + r_t)) − 1` over `[startDate, endDate]`. Pure price
   * quantity (dividend-inclusive via adjClose); matches the price chart
   * headline over the same dates. Null when any `1 + r ≤ 0` in the
   * slice (strict-drop, consistent with log-path policy).
   */
  realizedTotalReturn: number | null;
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
  normalization: {
    config: { rollingWindow: number; minObservations: number; winsorSigma: number; targetAnnualVol: number | null };
    ambiguousFactors: FactorCode[];
    insufficientObservationsByFactor: Record<string, number>;
    totalRowsDroppedForNormalization: number;
  };
  /**
   * Factors whose latest published row trails the freshest day in the
   * loaded factor matrix by more than 3 trading days. Computed once per
   * `runPerStockFactors` call (not per ticker) since the matrix is shared.
   * Empty array when all factors are fresh. See
   * `src/lib/factors/diagnostics/freshness.ts`.
   */
  factorDataStale: FactorStalenessEntry[];
}

interface PerStockParams {
  model: ModelPresetName;
  /** Regression window in trading days. */
  window: number;
  /** Optional sector filter (case-insensitive). */
  sector?: string | null;
  /** Optional sub-theme filter (case-insensitive). */
  subTheme?: string | null;
  /**
   * Restrict the run to a specific set of tickers (e.g. portfolio holdings).
   * Case-insensitive match. When set, sector/sub-theme filters still apply.
   */
  tickerSubset?: string[];
  /**
   * When true, attach `rollingResidualStream: {dates, residuals}` to each
   * PerStockRow. Internal-only — never serialised to the API. Used by the
   * portfolio residual service to build ε_p,t.
   */
  retainResidualStreams?: boolean;
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
      // Stored as daily simple decimal (KF native convention); no /252.
      rfByDate.set(d, Number(row.value));
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
  // Pre-window burn-in runway. Mirror the per-stock-timeseries service's
  // budget so the rolling-OLS sample feeding the grid's Σα / Σε column
  // covers the same dates the waterfall sums over.
  //
  // Three burn-in components stack at the front of the alignment loop:
  //   1. NORM_WARMUP (60): the per-stock factor normalization runs a
  //      252-day rolling window with `minObservations: 60`, so the first
  //      ~60 rows produce null and are dropped post-norm.
  //   2. ROLLING_OLS burn-in (GRID_ROLLING_WINDOW − 1 = 59): once
  //      normalization survives, the rolling regression itself needs W
  //      observations before producing its first fit.
  //   3. DATA_BUFFER (20): absorbs minor calendar misalignment / strict-
  //      drop losses so the visible model-window starts on a valid fit
  //      even when a handful of historic dates get dropped.
  //
  // MUST equal NORM_WARMUP + (GRID_ROLLING_WINDOW − 1) + DATA_BUFFER from
  // factor-per-stock-timeseries.service. If you change one, change both.
  const NORM_WARMUP = 60;
  const DATA_BUFFER = 20;
  const PRE_WINDOW_BURN_IN =
    NORM_WARMUP + (GRID_ROLLING_WINDOW - 1) + DATA_BUFFER;
  const windowFirstDate = alignedWindowDates[0] ?? null;
  const preWindowBurnInDates: string[] = (() => {
    if (!windowFirstDate || PRE_WINDOW_BURN_IN <= 0) return [];
    const idx = allDates.indexOf(windowFirstDate);
    if (idx <= 0) return [];
    const candidate = allDates.slice(Math.max(0, idx - PRE_WINDOW_BURN_IN), idx);
    return candidate.filter((d) =>
      usableFactors.every((c) => perFactorByDate.get(c)?.has(d)),
    );
  })();
  const extendedAlignedWindowDates = [
    ...preWindowBurnInDates,
    ...alignedWindowDates,
  ];
  const MODEL_START_IDX_EXT = preWindowBurnInDates.length;
  // Computed once per request — the matrix is shared across every constituent
  // so each row of the grid surfaces the same staleness diagnostic. RF is
  // folded in because the per-stock excess-return computation falls back to
  // `rfByDate.get(d) ?? 0` and silently inflates excess past the last RF print.
  const factorDataStale = detectFactorStaleness(factorByDate, usableFactors, {
    rfByDate,
  });
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
      normalization: {
        config: { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: 0.1 },
        ambiguousFactors: [],
        insufficientObservationsByFactor: {},
        totalRowsDroppedForNormalization: 0,
      },
      factorDataStale,
    };
  }

  // Pre-compute the factor matrix and full-window Σ for the aligned window
  // (used as the "legacy" reference per Phase 2 lock-in).
  const factorMatrix: number[][] = alignedWindowDates.map((d) => {
    const day = factorByDate.get(d)!;
    return usableFactors.map((c) => day[c] ?? 0);
  });
  const matrixNorm = normalizeFactorRows(
    factorMatrix,
    usableFactors.map((code) => ({ code, inputType: getFactorInputType(code) })),
    {
      rollingWindow: 252,
      minObservations: 60,
      winsorSigma: 5,
      targetAnnualVol: 0.1,
    },
  );
  // rfWindow was indexed positionally over alignedWindowDates; with the
  // per-stock alignment loop now iterating the EXTENDED sample, RF lookups
  // moved to direct `rfByDate.get(d)` reads, which is robust to the index
  // shift. Removed.

  const fullNormRows = matrixNorm.normalizedRows.filter(
    (row): row is number[] => row.every((v) => v != null && Number.isFinite(v)),
  );
  const factorSeriesColsFull = usableFactors.map((_, fi) => fullNormRows.map((row) => row[fi]!));
  const covMatrixFullWindow = factorCovarianceMatrix(factorSeriesColsFull, null, true);
  const minObs = minObservations(usableFactors.length);

  // Cumulative (geometric) factor returns over the full aligned window —
  // kept for the "legacy geometric" return contribution in each cell.
  const factorCumReturnsGeom: number[] = usableFactors.map((_, fi) => {
    let prod = 1;
    for (const row of factorMatrix) prod *= 1 + (row[fi] ?? 0);
    return prod - 1;
  });

  const allConstituents = await loadActiveConstituents({
    sector: params.sector,
    subTheme: params.subTheme,
  });
  const tickerSubsetUpper = params.tickerSubset
    ? new Set(params.tickerSubset.map((t) => t.toUpperCase()))
    : null;
  const constituents = tickerSubsetUpper
    ? allConstituents.filter((c) => tickerSubsetUpper.has(c.security.ticker.toUpperCase()))
    : allConstituents;

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
      normalization: {
        config: { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: 0.1 },
        ambiguousFactors: [],
        insufficientObservationsByFactor: {},
        totalRowsDroppedForNormalization: 0,
      },
      factorDataStale,
    };
  }

  // Price-history load extends back to the first EXTENDED date (model window
  // + pre-window burn-in runway) so the rolling-OLS sample has full coverage.
  const winStart = new Date(extendedAlignedWindowDates[0] ?? alignedWindowDates[0]!);
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
  const totalImputed = 0;
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
    //
    // Each kept row also carries `excessLog = ln(1 + r) − ln(1 + rf)` for
    // the parallel log-space regression path. Uses the clipped log helper:
    // a delisting-to-zero day shouldn't poison the entire stock's log
    // path; clipping with a flag is preferable to strict-drop for the
    // per-stock screener (the engine's strict-drop policy is still right
    // for the portfolio-level path).
    interface AlignedRow {
      factorRow: number[];
      excessReturn: number;
      /**
       * Raw daily simple stock return on this date: (P_t / P_{t-1}) − 1
       * via adjClose, so dividends are already included. Carried alongside
       * `excessReturn` so the realized total return column can be computed
       * directly from prices over arbitrary period slices, independent of
       * any beta / alpha / residual decomposition.
       */
      rawReturn: number;
      /**
       * Absolute adjusted-close price on this date (`cur` from priceMap).
       * Used to compute realized total return as a direct price ratio
       * (P_end / P_anchor) − 1 over arbitrary slices. This is robust to
       * multi-day gaps in the stock's price series — the chained
       * `exp(Σ ln(1 + r)) − 1` approach silently drops gap-down moves
       * when the alignment skips rows; the direct price ratio captures
       * them correctly because both endpoints are stored prices.
       */
      price: number;
      /**
       * Anchor price for computing the daily return on this row: the
       * adjClose at the trading day immediately before this row that the
       * stock actually traded on (resolved via the priceMap backsearch).
       * Stored so the realized total return helper can anchor a slice
       * starting at `startIdx == 0` to the same price `r[0]` was computed
       * against (i.e. the very first kept return is included in the
       * "over the slice" total).
       */
      prevPrice: number;
      excessLog: number;
      yClippedLog: boolean;
      /** True iff this row falls within the user-requested model window. */
      inModelWindow: boolean;
    }
    const aligned: AlignedRow[] = [];
    const alignedDates: string[] = [];
    const droppedDates: { date: string; factor: FactorCode }[] = [];
    // Iterate over the EXTENDED window (pre-window burn-in + model window).
    // The pre-window prefix never contributes to per-stock summary fields;
    // it only feeds the rolling-OLS sample so burn-in falls outside the
    // user's analysis window.
    for (let i = 0; i < extendedAlignedWindowDates.length; i++) {
      const d = extendedAlignedWindowDates[i]!;
      const dPrev = i === 0 ? null : extendedAlignedWindowDates[i - 1]!;
      const cur = priceMap.get(d);
      // Resolve `prev` with a 7-day backward calendar search whenever the
      // direct lookup fails. This handles two cases consistently:
      //   1) i === 0 — there's no `dPrev` in extendedAlignedWindowDates,
      //      so we walk back from `d` to find the most recent stored close.
      //   2) i > 0  — `dPrev` exists in the date union but priceMap has no
      //      entry for it. This happens when (a) the stock didn't trade on
      //      `dPrev` (e.g. multi-day halt or post-IPO gap) or (b) the date
      //      is a phantom from the factor matrix (AQR's global-calendar
      //      US holidays, FRED RF weekend rows). Without the backsearch
      //      the day's daily return is silently DROPPED — which collapses
      //      the chained `exp(Σ ln(1+r)) − 1` to a value disconnected from
      //      the actual price ratio (BATL 1Y was +51 % via skipped-gap
      //      compounding while the underlying price went 1.5 → 1.4 = −7 %).
      // Mirrors the same fix in factor-per-stock-timeseries.service.ts so
      // the grid's realizedTotalReturn ties to the per-stock chart's
      // `Total ≈ X%` line.
      let prev: number | undefined =
        dPrev != null ? priceMap.get(dPrev) : undefined;
      if (prev === undefined) {
        const check = new Date(d);
        for (let lag = 1; lag <= 7 && prev === undefined; lag++) {
          check.setUTCDate(check.getUTCDate() - 1);
          prev = priceMap.get(check.toISOString().slice(0, 10));
        }
      }
      if (cur == null || prev == null || prev <= 0) continue;
      const r = (cur - prev) / prev;
      const rfDaily = rfByDate.get(d) ?? 0;
      const excess = r - rfDaily;
      const inModelWindow = i >= MODEL_START_IDX_EXT;

      const rLog = logOnePlusClipped(r);
      const rfLog = logOnePlusClipped(rfDaily);
      let excessLog = Number.NaN;
      let yClippedLog = false;
      if (Number.isFinite(rLog.value) && Number.isFinite(rfLog.value)) {
        excessLog = rLog.value - rfLog.value;
        yClippedLog = rLog.clipped || rfLog.clipped;
      }

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
      aligned.push({
        factorRow: row,
        excessReturn: excess,
        rawReturn: r,
        price: cur,
        prevPrice: prev,
        excessLog,
        yClippedLog,
        inModelWindow,
      });
      alignedDates.push(d);
    }

    // Model-window-only count for the static-OLS DOF check (the pre-window
    // burn-in prefix doesn't count toward "enough data to fit").
    const modelWindowAlignedCount = aligned.reduce(
      (n, a) => n + (a.inModelWindow ? 1 : 0),
      0,
    );
    if (modelWindowAlignedCount < minObs) {
      skipped.push({ ticker, reason: "INSUFFICIENT_DOF" });
      continue;
    }

    const yRaw = aligned.map((a) => a.excessReturn);
    const xRaw = aligned.map((a) => a.factorRow);
    const alignedNorm = normalizeFactorRows(
      xRaw,
      usableFactors.map((code) => ({ code, inputType: getFactorInputType(code) })),
      {
        rollingWindow: 252,
        minObservations: 60,
        winsorSigma: 5,
        targetAnnualVol: 0.1,
      },
    );
    // EXTENDED arrays: full pre-window-burn-in + model-window sample. Used
    // for rolling OLS so burn-in falls in the pre-window prefix and the
    // resulting fits cover the entire model window.
    const yExt: number[] = [];
    const xExt: number[][] = [];
    const xRawExtKept: number[][] = [];
    const alignedExtKeptDates: string[] = [];
    const inModelWindowExt: boolean[] = [];
    /**
     * Raw daily simple stock returns aligned 1:1 with `yExt` /
     * `alignedExtKeptDates`. Used to compute realized total return
     * (Σ ln(1 + r) → exp − 1) over arbitrary slices, independent of
     * the regression. Dividend-inclusive (sourced from adjClose).
     */
    const rawReturnExt: number[] = [];
    /**
     * Absolute adjClose price at each kept aligned date (1:1 with
     * `rawReturnExt`). Anchors the realized-total-return helper to a
     * direct price ratio that captures multi-day gap moves the chained
     * sum drops.
     */
    const priceExt: number[] = [];
    /**
     * Anchor price (priceMap.get backsearch) for each kept row's daily
     * return. `priceExt[i] / prevPriceExt[i] - 1 == rawReturnExt[i]` by
     * construction. Used to anchor the realized-total-return helper when
     * the slice starts at `startIdx == 0`.
     */
    const prevPriceExt: number[] = [];
    const yLogExt: number[] = [];
    const xLogExt: number[][] = [];
    let logPathOk = true;
    let clippedLogDayCount = 0;
    for (let i = 0; i < yRaw.length; i++) {
      const row = alignedNorm.normalizedRows[i];
      if (!row || row.some((v) => v == null || !Number.isFinite(v))) continue;
      yExt.push(yRaw[i]!);
      xExt.push(row as number[]);
      xRawExtKept.push(xRaw[i]!);
      alignedExtKeptDates.push(alignedDates[i]!);
      inModelWindowExt.push(aligned[i]!.inModelWindow);
      rawReturnExt.push(aligned[i]!.rawReturn);
      priceExt.push(aligned[i]!.price);
      prevPriceExt.push(aligned[i]!.prevPrice);

      if (logPathOk) {
        const a = aligned[i]!;
        const xLogRow = factorRowLog(xRaw[i]!);
        if (!Number.isFinite(a.excessLog) || xLogRow === null) {
          logPathOk = false;
        } else {
          if (a.inModelWindow && a.yClippedLog) clippedLogDayCount++;
          yLogExt.push(a.excessLog);
          xLogExt.push(xLogRow);
        }
      }
    }
    // First index in the kept (extended) arrays where the model window
    // starts — used as the burn-in cutoff for rolling-fit α/ε sums and
    // as the slice point for static-OLS computations.
    const modelStartIdxExt = (() => {
      for (let i = 0; i < inModelWindowExt.length; i++) {
        if (inModelWindowExt[i]) return i;
      }
      return inModelWindowExt.length;
    })();

    // Model-window-only slices for the snapshot OLS, realized vol,
    // covariance, decompositions — every "static" stat anchored to the
    // user-requested window.
    const y = yExt.slice(modelStartIdxExt);
    const x = xExt.slice(modelStartIdxExt);
    const xRawKept = xRawExtKept.slice(modelStartIdxExt);
    const yLog = yLogExt.slice(modelStartIdxExt);
    const xLog = xLogExt.slice(modelStartIdxExt);
    /**
     * Raw daily simple stock returns sliced to the model window — aligns
     * 1:1 with `xRawKept` and the dates returned by
     * `alignedExtKeptDates.slice(modelStartIdxExt)`. Kept available for
     * any consumer that needs the per-day series; the `realizedTotalReturn`
     * helper below anchors directly to absolute prices instead so it is
     * robust to multi-day gaps in the stock's price series.
     */
    const rawReturn = rawReturnExt.slice(modelStartIdxExt);
    const priceArr = priceExt.slice(modelStartIdxExt);
    const prevPriceArr = prevPriceExt.slice(modelStartIdxExt);

    /**
     * Realized total return over `[startIdx, endIdx]` (inclusive) computed
     * as a direct price endpoint ratio:
     *
     *     anchor   = startIdx === 0 ? prevPriceArr[0] : priceArr[startIdx - 1]
     *     end      = priceArr[endIdx]
     *     return   = end / anchor − 1
     *
     * Anchor semantics: the price at the kept-aligned trading day
     * IMMEDIATELY BEFORE the slice's first date — i.e. the same anchor a
     * Σ ln(1+r) over `r[startIdx..endIdx]` would have if every `r` were
     * computed against the immediately previous trading day. For
     * `startIdx === 0` we fall back to `prevPriceArr[0]`, which is the
     * priceMap-backsearch result for the very first kept row (the price
     * the very first daily return was computed against).
     *
     * This formulation is robust to multi-day gaps in the stock's price
     * series (e.g. trading halts, post-IPO sparsity): the chained
     * `exp(Σ ln(1+r)) − 1` approach silently drops returns whenever a
     * row is skipped because its predecessor wasn't in priceMap, so a
     * −43 % gap-down move can simply vanish from the chained sum and
     * leave the chained "total" wildly disconnected from the actual
     * price ratio. The endpoint approach keeps both anchors as stored
     * prices and therefore matches the per-stock chart's headline
     * essentially exactly (modulo any drift between the slice's
     * resolved start date and the chart's calendar offset).
     *
     * Returns `null` when prices are missing or non-positive.
     */
    const realizedTotalReturnOver = (
      startIdx: number,
      endIdx: number,
    ): number | null => {
      if (startIdx < 0 || endIdx < startIdx || endIdx >= priceArr.length) {
        return null;
      }
      const anchor = startIdx === 0 ? prevPriceArr[0] : priceArr[startIdx - 1];
      const end = priceArr[endIdx];
      if (
        anchor == null ||
        end == null ||
        !Number.isFinite(anchor) ||
        !Number.isFinite(end) ||
        anchor <= 0
      ) {
        return null;
      }
      return end / anchor - 1;
    };
    const realizedTotalReturnFullWindow = realizedTotalReturnOver(
      0,
      priceArr.length - 1,
    );
    if (y.length < minObs) {
      skipped.push({ ticker, reason: "INSUFFICIENT_NORMALIZED_HISTORY" });
      continue;
    }
    const fit: RegressionFit = multivariateOls(y, x);
    // Log-space static OLS — null when the log path failed or the sample is too short.
    const fitLog: RegressionFit | null =
      logPathOk && yLog.length >= minObs ? multivariateOls(yLog, xLog) : null;

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
      fullNormRows.length,
    );

    // Cumulative additive factor returns over the stock's aligned window
    // (Σ r_t — matches the rolling-additive series displayed in the chart).
    const factorCumReturnsAdditive: number[] = usableFactors.map((_, fi) => {
      let s = 0;
      for (const row of xRawKept) s += row[fi] ?? 0;
      return s;
    });
    // Log-space cumulative factor returns (Σ ln(1+r_t)) over the same window,
    // for the static log-OLS factor contribution. Only meaningful when the
    // log path succeeded (fitLog != null), in which case xLog aligns 1:1 with
    // xRawKept / the model window.
    const factorCumReturnsAdditiveLog: number[] | null =
      fitLog != null
        ? usableFactors.map((_, fi) => {
            let s = 0;
            for (const row of xLog) s += row[fi] ?? 0;
            return s;
          })
        : null;

    // Per-factor cells.
    const cells: Partial<Record<FactorCode, PerStockFactorCell>> = {};
    for (let fi = 0; fi < usableFactors.length; fi++) {
      const code = usableFactors[fi]!;
      const beta = fit.betas[fi] ?? 0;
      const tStat = fit.tStats[fi] ?? 0;
      const returnContribution = beta * (factorCumReturnsAdditive[fi] ?? 0);
      const returnContributionLog =
        fitLog != null && factorCumReturnsAdditiveLog != null
          ? (fitLog.betas[fi] ?? 0) * (factorCumReturnsAdditiveLog[fi] ?? 0)
          : null;
      const returnContributionGeometric = beta * (factorCumReturnsGeom[fi] ?? 0);
      const riskContribution = decompAligned.factors[fi]?.pctVarianceContrib ?? 0;
      const cell: PerStockFactorCell = {
        beta,
        betaLog: fitLog ? (fitLog.betas[fi] ?? null) : null,
        tStat,
        returnContribution,
        returnContributionLog,
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

    // Fixed-W rolling OLS over the same aligned (y, X). NOTE (2026-06-21):
    // this is NO LONGER the source of the grid's Alpha / Unexplained columns
    // or the waterfall — those now use the static horizon-beta period
    // decomposition in `periodSlices` (one canonical estimator). The rolling
    // stream is retained ONLY to (a) drive the residual t-stat / CI band and
    // (b) feed the portfolio residual service's ε_p,t construction when
    // `retainResidualStreams` is set. The 60d-rolling betas on a 14-factor
    // model are too noisy to attribute per-factor returns from.
    let rollingAlphaPostBurnSum: number | null = null;
    let rollingResidualPostBurnSum: number | null = null;
    let rollingObservationsPostBurn = 0;
    let residualTStat: number | null = null;
    let residualCi95Half: number | null = null;
    let residualStreamForOutput: { dates: string[]; residuals: number[] } | undefined;
    if (yExt.length >= GRID_ROLLING_WINDOW + 1) {
      // Rolling OLS runs over the EXTENDED sample so pre-window dates
      // serve as burn-in runway. We then sum α/ε ONLY over indices
      // falling within the model window — the user's analysis window —
      // matching the per-stock-timeseries waterfall's sum range exactly.
      const datesUsed = params.retainResidualStreams
        ? alignedExtKeptDates
        : yExt.map((_, i) => String(i));
      const rolling = rollingMultivariateOls(datesUsed, yExt, xExt, GRID_ROLLING_WINDOW);
      let aSum = 0;
      let eSum = 0;
      let obs = 0;
      // Stash each post-burn-in rolling residual so we can derive the SD of
      // the residual stream itself. We can't reuse the per-day OLS residuals
      // (those condition on the full window) — the rolling residuals are the
      // actual realisations of unexplained drift the user sees in the chart.
      const rollingResiduals: number[] = [];
      const rollingResidualDates: string[] = [];
      for (let r = 0; r < rolling.length; r++) {
        const t = GRID_ROLLING_WINDOW - 1 + r;
        // Skip pre-window indices: the rolling fit at t looks back W days,
        // and we want sums to start once the *fit's right edge* lands in
        // the model window. Pre-window-edge fits exist (they're well-formed
        // OLS fits with W days of data) but their α/ε belong to a date
        // outside the user's window.
        if (t < modelStartIdxExt) continue;
        const rfit = rolling[r]!.fit;
        if (rfit.failed) continue;
        const xt = xExt[t];
        if (!xt) continue;
        let pred = rfit.alpha;
        for (let fi = 0; fi < k; fi++) pred += (rfit.betas[fi] ?? 0) * (xt[fi] ?? 0);
        const eps = (yExt[t] ?? 0) - pred;
        aSum += rfit.alpha;
        eSum += eps;
        rollingResiduals.push(eps);
        rollingResidualDates.push(rolling[r]!.date);
        obs++;
      }
      if (obs > 0) {
        rollingAlphaPostBurnSum = aSum;
        rollingResidualPostBurnSum = eSum;
        rollingObservationsPostBurn = obs;
        if (params.retainResidualStreams) {
          residualStreamForOutput = {
            dates: rollingResidualDates,
            residuals: rollingResiduals,
          };
        }
      }
      // T = Σε / (σ_ε × √n) where σ_ε is the SD of the rolling-OLS residual
      // stream itself (Bessel-corrected). Treats the residuals as draws from
      // an unknown-mean distribution and asks whether the cumulative drift
      // is statistically distinct from zero. CI half-width follows the same
      // SE on the sum: 1.96 × σ_ε × √n.
      if (obs >= 2) {
        const meanEps = rollingResiduals.reduce((s, v) => s + v, 0) / obs;
        const varEps =
          rollingResiduals.reduce((s, v) => s + (v - meanEps) ** 2, 0) / (obs - 1);
        const sdEps = Math.sqrt(Math.max(varEps, 0));
        const seSum = sdEps * Math.sqrt(obs);
        if (seSum > 0 && Number.isFinite(seSum) && rollingResidualPostBurnSum != null) {
          residualTStat = rollingResidualPostBurnSum / seSum;
          residualCi95Half = 1.96 * seSum;
        }
      }
    }

    // -------------------------------------------------------------------
    // Log-space rolling OLS — parallel to the simple-space block above,
    // run on (yLog, xLog). When the user has the screener in log
    // attribution mode (the default), the grid reads these fields so the
    // ALPHA / UNEXPLAINED columns match the per-stock waterfall's
    // log-space segments rather than the simple-space static-α (which
    // can disagree by Jensen's inequality on high-vol stocks).
    //
    // Annualisation reference (locked):
    //   Σ α_simple   = Σ daily α_simple over rolling W. Cumulative units;
    //                  ≈ α_simple × N for N rolling fits. NOT a compounded
    //                  return — sums of simple returns aren't compounding.
    //   α_simple_ann = α_simple_daily × 252. Linear scaling.
    //   Σ α_log      = Σ daily α_log over rolling W. Cumulative log
    //                  units; exp(Σ α_log) − 1 is the compounded
    //                  alpha-only geometric return on this stock.
    //   α_log_ann    = α_log_daily × 252.
    // The simple-space and log-space sums differ by approximately
    //   ≈ Σ (1/2) σ²_y_t × Δt
    // (Jensen's inequality on each day). For low-vol stocks the gap is
    // < 1pp; for a 290 %-vol stock it can be > 300pp.
    let rollingAlphaPostBurnSumLog: number | null = null;
    let rollingResidualPostBurnSumLog: number | null = null;
    let residualTStatLog: number | null = null;
    let residualCi95HalfLog: number | null = null;
    let residualStreamLogForOutput:
      | { dates: string[]; residuals: number[] }
      | undefined;
    if (logPathOk && yLogExt.length >= GRID_ROLLING_WINDOW + 1) {
      // Same extended-sample / model-window-sum convention as the simple
      // path above — this is what makes the grid's Σα (log) tie to the
      // waterfall's Σα (log) within numerical precision.
      const datesUsedLog = params.retainResidualStreams
        ? alignedExtKeptDates
        : yLogExt.map((_, i) => String(i));
      const rollingLog = rollingMultivariateOls(
        datesUsedLog,
        yLogExt,
        xLogExt,
        GRID_ROLLING_WINDOW,
      );
      let aSumLog = 0;
      let eSumLog = 0;
      let obsLog = 0;
      const rollingResidualsLog: number[] = [];
      const rollingResidualDatesLog: string[] = [];
      for (let r = 0; r < rollingLog.length; r++) {
        const t = GRID_ROLLING_WINDOW - 1 + r;
        if (t < modelStartIdxExt) continue;
        const rfit = rollingLog[r]!.fit;
        if (rfit.failed) continue;
        const xt = xLogExt[t];
        if (!xt) continue;
        let pred = rfit.alpha;
        for (let fi = 0; fi < k; fi++) pred += (rfit.betas[fi] ?? 0) * (xt[fi] ?? 0);
        const eps = (yLogExt[t] ?? 0) - pred;
        aSumLog += rfit.alpha;
        eSumLog += eps;
        rollingResidualsLog.push(eps);
        rollingResidualDatesLog.push(rollingLog[r]!.date);
        obsLog++;
      }
      if (obsLog > 0) {
        rollingAlphaPostBurnSumLog = aSumLog;
        rollingResidualPostBurnSumLog = eSumLog;
        if (params.retainResidualStreams) {
          residualStreamLogForOutput = {
            dates: rollingResidualDatesLog,
            residuals: rollingResidualsLog,
          };
        }
      }
      if (obsLog >= 2) {
        const meanEpsLog =
          rollingResidualsLog.reduce((s, v) => s + v, 0) / obsLog;
        const varEpsLog =
          rollingResidualsLog.reduce((s, v) => s + (v - meanEpsLog) ** 2, 0) /
          (obsLog - 1);
        const sdEpsLog = Math.sqrt(Math.max(varEpsLog, 0));
        const seSumLog = sdEpsLog * Math.sqrt(obsLog);
        if (
          seSumLog > 0 &&
          Number.isFinite(seSumLog) &&
          rollingResidualPostBurnSumLog != null
        ) {
          residualTStatLog = rollingResidualPostBurnSumLog / seSumLog;
          residualCi95HalfLog = 1.96 * seSumLog;
        }
      }
    }

    // -------------------------------------------------------------------
    // Period slices — STATIC-BETA decomposition restricted to each trailing
    // reporting period. The single horizon-window OLS fit (`fit` / `fitLog`)
    // supplies the betas AND the intercept; we apply them across the slice so
    // every per-stock number (grid columns + waterfall) shares one estimator
    // and ties by construction. modelDates aligns 1:1 with xRawKept / y / yLog.
    //
    // Per slice [s, e] (obs = e − s + 1):
    //   returnByFactor[f] = β_f × Σ_{i∈[s,e]} r_{i,f}
    //   alphaSum          = α × obs                       (static intercept × days)
    //   residualSum       = Σ_{i∈[s,e]} y_i − Σ_f returnByFactor[f] − alphaSum
    // and identically in log space using fitLog / yLog when the log path ran.
    // -------------------------------------------------------------------
    const periodSlices = (() => {
      const modelDates = alignedExtKeptDates.slice(modelStartIdxExt);
      const labels: PeriodLabel[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];
      const out = {} as Record<PeriodLabel, PerStockPeriodSlice>;
      for (const label of labels) {
        const slice = resolvePeriodSlice(modelDates, label);
        const { startIndex, endIndex } = slice;
        const returnByFactor: Partial<Record<FactorCode, number>> = {};
        const returnByFactorLog: Partial<Record<FactorCode, number>> = {};
        let alphaSum: number | null = null;
        let residualSum: number | null = null;
        let alphaSumLog: number | null = null;
        let residualSumLog: number | null = null;
        let observations = 0;
        if (startIndex >= 0) {
          observations = endIndex - startIndex + 1;
          // Simple-space static-beta decomposition (one canonical estimator,
          // shared with the per-stock waterfall via `computeStaticBetaPeriodSlice`).
          const decompSimple = computeStaticBetaPeriodSlice(
            fit.betas,
            fit.alpha,
            xRawKept.slice(startIndex, endIndex + 1),
            y.slice(startIndex, endIndex + 1),
          );
          for (let fi = 0; fi < usableFactors.length; fi++) {
            returnByFactor[usableFactors[fi]!] = decompSimple.returnByFactor[fi] ?? 0;
          }
          alphaSum = decompSimple.alphaSum;
          residualSum = decompSimple.residualSum;
          // Log-space static-beta decomposition (only when the log fit ran;
          // xLog / yLog then align 1:1 with the model window).
          if (fitLog != null) {
            const decompLog = computeStaticBetaPeriodSlice(
              fitLog.betas,
              fitLog.alpha,
              xLog.slice(startIndex, endIndex + 1),
              yLog.slice(startIndex, endIndex + 1),
            );
            for (let fi = 0; fi < usableFactors.length; fi++) {
              returnByFactorLog[usableFactors[fi]!] = decompLog.returnByFactor[fi] ?? 0;
            }
            alphaSumLog = decompLog.alphaSum;
            residualSumLog = decompLog.residualSum;
          }
        }
        // Realized total stock return over this period's date range:
        // exp(Σ ln(1 + r)) − 1 over [startIndex, endIndex] of `rawReturn`.
        // Pure price quantity (dividend-inclusive via adjClose), so it
        // matches the price chart headline over the same dates and is
        // independent of the regression's beta / alpha / residual split.
        const realizedTotalReturn =
          startIndex >= 0 ? realizedTotalReturnOver(startIndex, endIndex) : null;
        out[label] = {
          returnByFactor,
          returnByFactorLog,
          alphaSum,
          residualSum,
          alphaSumLog,
          residualSumLog,
          observations,
          startDate: slice.startDate,
          endDate: slice.endDate,
          realizedTotalReturn,
        };
      }
      return out;
    })();

    rows.push({
      ticker,
      name: c.security.name,
      sector: c.sector,
      subTheme: c.subTheme,
      cells,
      periodSlices,
      realizedTotalReturn: realizedTotalReturnFullWindow,
      rSquared: fit.rSquared,
      alphaAnnualized: fit.alpha * TRADING_DAYS,
      alphaDaily: fit.alpha,
      alphaDailyLog: fitLog ? fitLog.alpha : null,
      alphaTStat: fit.alphaTStat,
      alphaStdError: fit.alphaStdError,
      alphaStdErrorAnnualized: fit.alphaStdError * TRADING_DAYS,
      alphaCi95Half: 1.96 * fit.alphaStdError * TRADING_DAYS,
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
      residualTStat,
      residualCi95Half,
      ...(residualStreamForOutput ? { rollingResidualStream: residualStreamForOutput } : {}),
      // Log-space outputs — parallel to the simple-space fields. Consumers
      // that want to render in log-space attribution mode read these.
      alphaAnnualizedLog: fitLog ? fitLog.alpha * TRADING_DAYS : null,
      alphaTStatLog: fitLog ? fitLog.alphaTStat : null,
      alphaStdErrorLog: fitLog ? fitLog.alphaStdError : null,
      alphaCi95HalfLog: fitLog ? 1.96 * fitLog.alphaStdError * TRADING_DAYS : null,
      rollingAlphaPostBurnSumLog,
      rollingResidualPostBurnSumLog,
      residualTStatLog,
      residualCi95HalfLog,
      ...(residualStreamLogForOutput
        ? { rollingResidualStreamLog: residualStreamLogForOutput }
        : {}),
      clippedLogDayCount,
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
    normalization: matrixNorm.diagnostics,
    factorDataStale,
  };
}

/** Helper: build a list of {code, label} for the UI. */
export function describeFactors(codes: FactorCode[]): { code: FactorCode; label: string; shortLabel: string }[] {
  return codes.map((c) => {
    const def = getFactorDef(c);
    return { code: c, label: def.label, shortLabel: def.shortLabel };
  });
}
