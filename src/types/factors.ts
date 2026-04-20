/**
 * Shared typed contracts for the institutional factor analysis engine.
 * All API responses, service outputs, and lib module returns are shaped by these types.
 */

// ---------------------------------------------------------------------------
// Factor model definitions
// ---------------------------------------------------------------------------

/** Factor codes that correspond to FactorCode enum in Prisma schema + any computed ones. */
export type FactorCode = "MKT_RF" | "SMB" | "HML" | "RMW" | "CMA" | "MOM" | "RF";

/** Supported regression model presets. */
export type ModelPresetName = "CAPM" | "FF3" | "CARHART4" | "FF5" | "EXTENDED";

export interface FactorDef {
  code: FactorCode;
  label: string;
  shortLabel: string;
  description: string;
  whyItMatters: string;
  units: "beta" | "zscore" | "pct";
  color: string;
}

export interface ModelPreset {
  name: ModelPresetName;
  label: string;
  description: string;
  factors: FactorCode[];
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
  /** Annualized alpha (daily intercept × 252). */
  alphaAnnualized: number;
  alphaTStat: number;
  rSquared: number;
  adjRSquared: number;
  /** Herfindahl-Hirschman index of factor risk contributions (0 = diversified, 1 = concentrated). */
  concentrationHHI: number;
  systematicShare: number;
  idiosyncraticShare: number;
  model: ModelPresetName;
  window: number;
  n: number;
  asOfDate: string;
  hasFundamentals: boolean;
  regularized: boolean;
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

export interface AttributionResult {
  daily: AttributionDayPoint[];
  cumulative: CumulativeAttributionPoint[];
  periods: PeriodAttributionSummary[];
  provenanceBadge: {
    frenchThrough: string;
    proxyFrom: string;
    proxyTo: string;
  } | null;
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

export interface FactorMarketContext {
  stats: FactorMarketStat[];
  /** Correlation matrix — factors in same order as stats. */
  correlationMatrix: number[][];
  correlationWindow: number;
  asOfDate: string;
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
  /** Exponential weighting half-life in trading days. null = uniform. */
  ewHalfLife?: number | null;
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
}
