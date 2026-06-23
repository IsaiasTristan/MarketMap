/**
 * Shared typed contracts for the institutional factor analysis engine.
 * All API responses, service outputs, and lib module returns are shaped by these types.
 */

// ---------------------------------------------------------------------------
// Factor model definitions
// ---------------------------------------------------------------------------

/** Factor codes that correspond to FactorCode enum in Prisma schema + any computed ones. */
export type FactorCode =
  // Fama-French / Carhart factors
  | "MKT_RF" | "SMB" | "HML" | "RMW" | "CMA" | "MOM" | "RF"
  // Macro asset-class factors (MACRO14)
  | "EQ" | "LOCAL_EQ" | "RATES" | "COMM" | "EM" | "FX" | "INFL"
  // Style / cross-sectional risk premia (MACRO14)
  | "SHORT_VOL" | "TREND" | "BAB" | "QMJ" | "CROWD";

/** Supported regression model presets. */
export type ModelPresetName = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED" | "MACRO14";

/** Canonical input handling for factor normalization pre-regression. */
export type FactorInputType = "RETURN" | "FIRST_DIFFERENCE" | "AMBIGUOUS";

/** Coverage status of a factor for a particular regression window. */
export type FactorCoverageStatus =
  | "OK"
  | "INSUFFICIENT_HISTORY"
  | "MISSING_DATA";

export interface FactorCoverage {
  code: FactorCode;
  status: FactorCoverageStatus;
  inceptionDate: string | null;
  observationsAvailable: number;
}

export interface FactorDef {
  code: FactorCode;
  label: string;
  shortLabel: string;
  description: string;
  whyItMatters: string;
  /** Concise one-line description of how the factor return is constructed. */
  howCalculated: string;
  /**
   * Underlying data/series the factor is built from (ETF ticker, AQR/Ken
   * French series, frequency, provider) — surfaced as the tooltip "Data used"
   * line so the user can see the provenance of every number.
   */
  dataSource?: string;
  units: "beta" | "zscore" | "pct";
  color: string;
  inputType: FactorInputType;
}

export interface FactorNormalizationConfig {
  rollingWindow: number;
  minObservations: number;
  winsorSigma: number;
  targetAnnualVol: number | null;
}

export interface FactorNormalizationDiagnostics {
  config: FactorNormalizationConfig;
  ambiguousFactors: FactorCode[];
  insufficientObservationsByFactor: Record<string, number>;
  totalRowsDroppedForNormalization: number;
}

/**
 * Per-factor staleness diagnostic. Emitted by `detectFactorStaleness` whenever
 * the most recent published row for a factor lags the freshest day in the
 * factor matrix by more than `thresholdTradingDays` weekday days.
 *
 * Used to surface a UI warning when KF / AQR / Yahoo data hasn't been
 * refreshed and a silent zero-RF or strict-drop is happening at the back of
 * the regression sample.
 */
export interface FactorStalenessEntry {
  /** Factor code that is stale. RF is included for risk-free staleness. */
  factor: FactorCode;
  /** ISO date (YYYY-MM-DD) of the latest non-null row for this factor. */
  lastDate: string;
  /** ISO date of the freshest day across the entire factor matrix + RF. */
  referenceDate: string;
  /**
   * Trading-day distance from `lastDate` (exclusive) to `referenceDate`
   * (inclusive). Counts weekdays only; equals 0 when `lastDate ≥ referenceDate`.
   */
  lagTradingDays: number;
}

export interface ModelPreset {
  name: ModelPresetName;
  label: string;
  description: string;
  factors: FactorCode[];
}

/**
 * Portfolio data-coverage diagnostics for the factor regression.
 *
 * The engine builds the portfolio return series from the UNION of position
 * price dates, including each holding only on dates it actually traded and
 * renormalizing weights across the present subset. A recently-listed holding
 * (IPO / short history) therefore contributes only once it has prices instead
 * of truncating the whole portfolio's aligned window. This object names which
 * holdings / dates were excluded so the UI can surface a concise warning.
 */
export interface PortfolioCoverageDiagnostics {
  totalPositions: number;
  /** First date of the kept (regressable) portfolio return series. */
  seriesStart: string | null;
  /** Last date of the kept portfolio return series. */
  seriesEnd: string | null;
  /** Number of dates in the kept series. */
  alignedDates: number;
  /**
   * Holdings that started after the series began (IPOs / short history) and so
   * are absent from the early part of the regression sample.
   */
  shortHistoryPositions: { ticker: string; firstDate: string; observations: number }[];
  /** Holdings that never contributed (no usable overlapping price history). */
  excludedPositions: { ticker: string; reason: string }[];
  /** Count of candidate dates dropped because portfolio coverage fell below the threshold. */
  droppedLowCoverageDates: number;
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

/** Result of a single multivariate OLS fit (includes intercept as first element). */
export interface RegressionFit {
  /** Factor betas in model order (does NOT include intercept). */
  betas: number[];
  /** Regression alpha / intercept (daily). */
  alpha: number;
  /** Residuals vector (length = n). */
  residuals: number[];
  /** R-squared. */
  rSquared: number;
  /** Adjusted R-squared. */
  adjRSquared: number;
  /** t-statistics for each beta (same order as betas). */
  tStats: number[];
  /** Standard errors for each beta (same order as betas). */
  stdErrors: number[];
  /** t-statistic for alpha. */
  alphaTStat: number;
  /** Standard error for alpha. */
  alphaStdError: number;
  /** Number of observations used in the regression. */
  n: number;
  /** Number of factors (not counting intercept). */
  k: number;
  /** True if Tikhonov ridge regularization was applied due to near-singularity. */
  regularized: boolean;
  /**
   * True when the regression fit could not be solved at all — either
   * `n < k + 2` (insufficient degrees of freedom) or both the direct
   * `(X'WX)⁻¹` invert AND the ridge fallback returned a singular pivot.
   * Callers MUST treat this fit as garbage (do not include in cumulative
   * sums or charts). Phase 3 lock-in: no silent degradation.
   */
  failed: boolean;
}

/** One entry in a rolling regression output series. */
export interface RollingFitPoint {
  date: string;
  fit: RegressionFit;
}

/** Rolling exposure for a single factor across time. */
export interface RollingFactorBeta {
  code: FactorCode;
  label: string;
  dates: string[];
  betas: number[];
  tStats: number[];
}

// ---------------------------------------------------------------------------
// Exposure snapshot
// ---------------------------------------------------------------------------

export interface FactorExposureEntry {
  code: FactorCode;
  label: string;
  beta: number;
  tStat: number;
  stdError: number;
  /** Holdings-implied score (style z-score from fundamentals + price momentum). */
  holdingsImplied: number | null;
  /** Percentage contribution to total portfolio risk (variance). */
  pctRiskContrib: number;
  /** Percentage contribution to portfolio return over selected period. */
  pctReturnContrib: number;
}

export interface FactorExposureSnapshot {
  factors: FactorExposureEntry[];
  /** Annualized alpha (daily intercept × 252). Simple-return space. */
  alphaAnnualized: number;
  alphaTStat: number;
  /**
   * Log-space static alpha annualised (`α_log_daily × 252`) from the
   * engine's `endFitLog`. Optional for back-compat — older snapshots
   * leave it undefined and the UI falls back to simple-space rendering.
   * For high-vol portfolios `alphaAnnualizedLog` can disagree wildly with
   * `alphaAnnualized` due to Jensen's inequality on each day's residual.
   */
  alphaAnnualizedLog?: number | null;
  alphaTStatLog?: number | null;
  /** Log-space CI half-width on the annualised log α: 1.96 × SE(α_log) × 252. */
  alphaCi95HalfLog?: number | null;
  rSquared: number;
  adjRSquared: number;
  /** Herfindahl-Hirschman index of factor risk contributions (0 = diversified, 1 = concentrated). */
  concentrationHHI: number;
  systematicShare: number;
  idiosyncraticShare: number;
  /**
   * Realised annualised σ of the portfolio's excess return over the
   * regression-aligned sample. Phase 3 lock-in: the PRIMARY headline
   * volatility (anchor to realised, model-implied for reconciliation).
   * Optional for back-compat — old engines that don't compute this leave
   * it undefined and the UI falls back to model-implied.
   */
  realizedAnnualizedVol?: number;
  /**
   * (model_var − realised_var) / realised_var. Var-gap badge thresholds
   * (Q4 lock): |gap| < 2% → no badge, 2-5% → neutral, ≥ 5% → amber.
   */
  varGapPct?: number;
  /**
   * Portfolio-level "Unexplained" residual stats — feeds the Total row's
   * Unexplained cell in the Exposure grid across STAT = Value / T / CI.
   * Constructed as ε_p,t = Σ_i w_i · ε_i,t from per-stock rolling-OLS
   * residuals with snapshot weights and fixed membership; T-stat and CI
   * use Newey-West (1994) HAC SE on the mean. See
   * `factor-portfolio-residual.service.ts` for methodology.
   * Optional for back-compat — old snapshots leave it undefined.
   */
  residual?: {
    // Simple-space (existing fields)
    sum: number;
    mean: number;
    tStat: number;
    ci95Half: number;
    annualizedVol: number;
    bandwidth: number;
    n: number;
    startDate: string;
    endDate: string;
    droppedHoldings: string[];
    coverageWeight: number;
    // Log-space mirror — null when the log path failed for any
    // contributing holding; the UI falls back to simple in that case.
    sumLog?: number | null;
    meanLog?: number | null;
    tStatLog?: number | null;
    ci95HalfLog?: number | null;
    annualizedVolLog?: number | null;
    bandwidthLog?: number | null;
    nLog?: number | null;
  };
  model: ModelPresetName;
  window: number;
  n: number;
  asOfDate: string;
  hasFundamentals: boolean;
  regularized: boolean;
  normalizationApplied: boolean;
  normalization: FactorNormalizationDiagnostics | null;
  /**
   * Data-coverage diagnostics — which holdings / dates were excluded from the
   * regression sample (short history / IPOs / low-coverage dates). Optional for
   * back-compat; the UI shows a concise warning chip when populated.
   */
  coverage?: PortfolioCoverageDiagnostics | null;
}

// ---------------------------------------------------------------------------
// Risk decomposition
// ---------------------------------------------------------------------------

export interface FactorRiskEntry {
  code: FactorCode;
  label: string;
  beta: number;
  /** Marginal contribution to portfolio volatility: (Σβ)_f / σ_p */
  marginalCR: number;
  /** Risk contribution in volatility terms: β_f × (Σβ)_f / σ_p */
  riskContrib: number;
  /** Percent of total portfolio variance. */
  pctVarianceContrib: number;
}

export interface RiskDecomposition {
  /** Annualized total portfolio volatility (σ_p). */
  totalVolatility: number;
  /** sqrt(β'Σβ) annualized. */
  systematicVolatility: number;
  /** sqrt(var(residuals)) annualized. */
  idiosyncraticVolatility: number;
  systematicShare: number;
  idiosyncraticShare: number;
  factors: FactorRiskEntry[];
  /** Covariance matrix used (factor order matches model preset). */
  covMatrix: number[][];
  covMatrixWindow: number;
  /**
   * Window-scoped coverage diagnostics — names which holdings have no /
   * partial price data inside the trailing risk window. Surfaced by the
   * `/api/analysis/factors/risk` route so the Risk tab's CoverageWarning
   * chip can list affected tickers + their data date ranges. Optional on
   * the type because legacy consumers (computeRiskDecomposition pure path)
   * don't populate it; the API spreads it on top of the engine result.
   */
  windowCoverage?: PortfolioCoverageDiagnostics;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface AttributionDayPoint {
  date: string;
  /** Total portfolio return (excess of RF). */
  portExcessReturn: number;
  /** Daily RF contribution. */
  rfContrib: number;
  /** Factor contributions in model order. */
  byFactor: Record<FactorCode, number>;
  /** Residual alpha on this day. */
  alpha: number;
}

export interface CumulativeAttributionPoint {
  date: string;
  cumulativePortReturn: number;
  cumulativeAlpha: number;
  cumulativeRf: number;
  byFactor: Record<string, number>;
}

export interface PeriodAttributionSummary {
  label: string;
  startDate: string;
  endDate: string;
  totalReturn: number;
  factorReturn: number;
  rfReturn: number;
  alpha: number;
  byFactor: { code: FactorCode; label: string; contribution: number; pct: number }[];
}

/**
 * Daily log-return attribution point. Mirrors {@link AttributionDayPoint}
 * but in log space — the multi-period sum of `portExcessLogReturn` equals
 * `ln(Π(1 + r_t_simple_excess))`, so `exp(Σ portExcessLogReturn) - 1` is the
 * compounded geometric realised excess return for the period.
 */
export interface AttributionDayPointLog {
  date: string;
  /** Daily excess log return: ln(1 + r_stock) - ln(1 + r_f). */
  portExcessLogReturn: number;
  /** Daily RF log contribution: ln(1 + r_f). */
  rfLogContrib: number;
  /** β_f * ln(1 + f_simple) per factor. */
  byFactor: Record<FactorCode, number>;
  /** y_log - Σ(β·x_log). */
  alpha: number;
}

export interface CumulativeAttributionPointLog {
  date: string;
  /** Σ daily portExcessLogReturn up to this date. Use `exp(.) - 1` to compound. */
  cumulativePortLogReturn: number;
  /** `exp(cumulativePortLogReturn) - 1` for chart convenience. */
  cumulativePortGeometric: number;
  cumulativeAlpha: number;
  cumulativeRf: number;
  /** Σ per-factor log contribution. */
  byFactor: Record<string, number>;
}

export interface PeriodAttributionSummaryLog {
  label: string;
  startDate: string;
  endDate: string;
  /** Σ y_log over the period. */
  totalLogReturn: number;
  /** exp(totalLogReturn) - 1: geometric compounded excess. */
  totalGeometricReturn: number;
  /** Σ Σ_f β·x_log. */
  factorLogReturn: number;
  /** Σ ln(1 + r_f). */
  rfLogReturn: number;
  alpha: number;
  byFactor: { code: FactorCode; label: string; contribution: number; pct: number }[];
}

export interface AttributionResult {
  /**
   * Full-length daily attribution using the horizon end-fit betas (NOT the
   * rolling-fit tail). Defined for every aligned date so trailing reporting
   * periods slice correctly at any horizon. Feeds `periods` and the
   * period-sliced variance decomposition (`pickPeriodRiskSummary`).
   */
  daily: AttributionDayPoint[];
  /** Rolling-beta cumulative path — drives the time-series chart. */
  cumulative: CumulativeAttributionPoint[];
  periods: PeriodAttributionSummary[];
  /** Path B: log-return attribution (null when log path unavailable). */
  dailyLog: AttributionDayPointLog[] | null;
  cumulativeLog: CumulativeAttributionPointLog[] | null;
  periodsLog: PeriodAttributionSummaryLog[] | null;
  provenanceBadge: {
    frenchThrough: string;
    proxyFrom: string;
    proxyTo: string;
  } | null;
  /**
   * Live 1D overlay (only present in REGULAR US market hours).
   *
   * When set, the "1D" entries inside `periods` and `periodsLog` have been
   * REPLACED with values computed from today's live ETF + holdings quotes,
   * using the horizon end-fit betas + intercept. The cached at-close 1D
   * bucket is overwritten — there is no parallel "at-close" 1D number on
   * the result object, mirroring the per-stock detail panel's behaviour
   * (live takes precedence; at-close is the fallback when live is null).
   *
   * The UI reads this to render the live-vs-at-close freshness badge.
   *
   * Optional in the type so call sites that don't compute live data (legacy
   * snapshots, tests, alternative entry points) still build a valid result.
   */
  live1D?: {
    /** ISO timestamp when the live row was composed. */
    asOf: string;
    /** US market session at fetch time. */
    session?: import("@/lib/market-map/market-session").MarketSession;
    /** ETF legs that were missing — surfaces in the badge tooltip. */
    missingLegs: string[];
    /** Factors that were live-decomposed (intersection of endFit and live row). */
    factorsUsed: FactorCode[];
    /** Names of holdings without a live quote — degrades the live weighted return. */
    missingHoldings: string[];
  } | null;
  /** Set when inline live 1D overlay failed on the full attribution fetch. */
  live1DFailureReason?:
    | "ENGINE_UNAVAILABLE"
    | "NO_LIVE_FACTORS"
    | "NO_POSITIONS"
    | "NO_HOLDING_QUOTES"
    | null;
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export interface PositionLoadings {
  ticker: string;
  sector: string;
  subTheme: string;
  weight: number;
  /** Per-factor loading (beta) estimated from this position's return series. */
  loadings: Partial<Record<FactorCode, number>>;
}

export interface FactorDriverEntry {
  key: string;
  label: string;
  weight: number;
  loading: number;
  contribution: number;
}

export interface FactorDriversEntry {
  code: FactorCode;
  label: string;
  portfolioExposure: number;
  topPositive: FactorDriverEntry[];
  topNegative: FactorDriverEntry[];
  concentrationHHI: number;
}

export interface DriversResult {
  groupBy: "position" | "sector" | "subTheme";
  factors: FactorDriversEntry[];
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export interface FactorShock {
  code: FactorCode;
  /** Shock magnitude in factor units (e.g. 0.01 = 1-day 1% for MKT_RF). */
  shockValue: number;
}

export interface ScenarioDefinition {
  key: string;
  label: string;
  description: string;
  shocks: FactorShock[];
  isHistorical?: boolean;
  historicalWindow?: { start: string; end: string };
}

export interface ScenarioPositionImpact {
  ticker: string;
  weight: number;
  estimatedPnl: number;
}

export interface ScenarioResult {
  scenario: ScenarioDefinition;
  /** Estimated portfolio P&L (as a decimal return, e.g. -0.03 = -3%). */
  estimatedPortPnl: number;
  byFactor: { code: FactorCode; label: string; shockValue: number; contribution: number }[];
  byPosition: ScenarioPositionImpact[];
  asOfDate: string;
}

export interface SensitivityEntry {
  code: FactorCode;
  label: string;
  beta: number;
  shock1Sig: number;
  shock2Sig: number;
  impact1Sig: number;
  impact2Sig: number;
  impactNeg1Sig: number;
  impactNeg2Sig: number;
}

// ---------------------------------------------------------------------------
// Market context
// ---------------------------------------------------------------------------

export interface FactorMarketStat {
  code: FactorCode;
  label: string;
  return1D: number | null;
  return5D: number | null;
  return1M: number | null;
  return3M: number | null;
  return6M: number | null;
  return1Y: number | null;
  annualizedVol: number | null;
  sharpeRatio: number | null;
}

export interface FactorMulticollinearity {
  /** Variance Inflation Factor per factor (same order as stats). */
  vif: number[];
  /** Condition number κ = √(λmax / λmin) of the correlation matrix. */
  conditionNumber: number;
  /** Pairwise |ρ| ≥ flagThreshold (i, j refer to indices in stats[]). */
  highPairs: { i: number; j: number; rho: number }[];
  /** Threshold used for `highPairs` (default 0.7). */
  flagThreshold: number;
}

export interface FactorMarketContext {
  stats: FactorMarketStat[];
  /** Correlation matrix — factors in same order as stats. */
  correlationMatrix: number[][];
  correlationWindow: number;
  asOfDate: string;
  /** Multicollinearity diagnostics over the same window as the correlations. */
  multicollinearity: FactorMulticollinearity;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type FactorAlertType =
  | "factor_drift"
  | "factor_concentration"
  | "active_risk_spike"
  | "alpha_deterioration"
  | "sector_domination"
  | "factor_breach";

export interface FactorAlert {
  id: string;
  at: string;
  type: FactorAlertType;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Engine params / result
// ---------------------------------------------------------------------------

/** Parameters passed to the factor engine for a computation. */
export interface FactorEngineParams {
  portfolioId: string;
  model: ModelPresetName;
  /** Regression window in trading days. */
  window: number;
  from?: string;
  to?: string;
}

/** Full engine result returned by the orchestrator. */
export interface FactorEngineResult {
  /** Aligned date series. */
  dates: string[];
  /** Daily portfolio excess returns (total return - RF). */
  portExcessReturns: number[];
  /** Daily portfolio total returns. */
  portTotalReturns: number[];
  /** Factor return series aligned to dates. Key = FactorCode. */
  factorReturns: Record<string, number[]>;
  /** Daily RF rate aligned to dates. */
  rfReturns: number[];
  /** The single end-of-period regression fit over the full window. */
  endFit: RegressionFit;
  /** Rolling fits (one per date after window). */
  rollingFits: RollingFitPoint[];
  /** Risk decomposition computed from endFit. */
  risk: RiskDecomposition;
  /** Holdings-implied style z-scores (secondary view). null if no fundamentals. */
  holdingsImplied: Partial<Record<FactorCode, number>> | null;
  model: ModelPresetName;
  factors: FactorCode[];
  normalization: FactorNormalizationDiagnostics;

  // ---- Path B (log-return) ----------------------------------------------
  /**
   * Daily portfolio excess log return: `ln(1 + r_p) - ln(1 + r_f)`.
   * Length matches `dates`. Null when the log path could not be built
   * (e.g. a daily simple return ≤ -1 — vanishingly rare for a portfolio).
   */
  portExcessLogReturns: number[] | null;
  /** Per-factor daily log return: `ln(1 + f_simple)`. Null when log path unavailable. */
  factorLogReturns: Record<string, number[]> | null;
  /** Daily RF log return: `ln(1 + r_f)`. */
  rfLogReturns: number[] | null;
  /**
   * End-of-period OLS fit on the log design matrix (raw log factors,
   * NOT vol-scaled). Null when log path unavailable.
   */
  endFitLog: RegressionFit | null;
  /** Rolling fits on the log design matrix. */
  rollingFitsLog: RollingFitPoint[] | null;

  /**
   * Set when the requested regression window exceeded the available aligned
   * history and the rolling window had to shrink so the engine still emits
   * at least one rolling fit (the same shape used by per-stock timeseries).
   * Null when `availableObservations >= requestedWindow`.
   */
  windowFallback: {
    requestedWindow: number;
    effectiveWindow: number;
    availableObservations: number;
  } | null;

  /** Data-coverage diagnostics for the portfolio return series. */
  coverage: PortfolioCoverageDiagnostics;

  /**
   * Coverage diagnostics scoped to the trailing risk-decomposition window
   * (the last `windowN` aligned dates that feed the Euler decomposition).
   * Names short-history / zero-data holdings within this window so the
   * Risk-tab warning chip can list affected tickers + date ranges.
   * Always present — `seriesStart`/`seriesEnd` span the risk window.
   */
  windowCoverage: PortfolioCoverageDiagnostics;
}
