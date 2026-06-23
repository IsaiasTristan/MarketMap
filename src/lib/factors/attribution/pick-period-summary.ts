/**
 * pickPeriodSummary — single source of truth for resolving the portfolio
 * attribution panels' "selected period" + "attribution mode" into one
 * normalized summary the UI can render directly.
 *
 * The attribution endpoint returns BOTH a simple-return (`periods`) and a
 * log-return (`periodsLog`) bucket set. The portfolio panels historically
 * read only `periods`, so changing the Attribution mode toggle had no effect
 * and the geometric headline (which reconciles to compounded realised return)
 * was never shown. This helper picks the right bucket for the requested mode,
 * falling back to the other mode when the preferred one is unavailable so
 * that period selection always works whenever ANY period data exists.
 */
import type {
  AttributionResult,
  FactorCode,
  PeriodAttributionSummary,
  PeriodAttributionSummaryLog,
} from "@/types/factors";
import type { FactorAttributionMode, FactorPeriod } from "@/store/analysis";

export interface PickedPeriodSummary {
  /** True when the numbers come from the log-return bucket. */
  isLog: boolean;
  label: string;
  startDate: string;
  endDate: string;
  /**
   * Display total return for the headline: geometric `exp(Σy_log) − 1` in log
   * mode, arithmetic `Σ y_simple` in simple mode.
   */
  totalReturn: number;
  /** Σ y_log over the period (log mode only) — for the muted reconciliation sub-line. */
  totalLogReturn: number | null;
  alpha: number;
  byFactor: { code: FactorCode; label: string; contribution: number }[];
}

/**
 * Resolve `(attribution, period, mode)` to a single normalized summary.
 * Returns `null` when no period bucket is available for the given label in
 * either mode (caller should fall back to a whole-window snapshot).
 */
export function pickPeriodSummary(
  attribution: AttributionResult | null | undefined,
  period: FactorPeriod,
  mode: FactorAttributionMode,
): PickedPeriodSummary | null {
  if (!attribution) return null;

  const logSummary = attribution.periodsLog?.find((p) => p.label === period) ?? null;
  const simpleSummary = attribution.periods?.find((p) => p.label === period) ?? null;

  const preferLog = mode === "log";
  const useLog = preferLog ? logSummary != null : false;

  if (useLog && logSummary) {
    if (logSummary.byFactor.length === 0) return null;
    return {
      isLog: true,
      label: logSummary.label,
      startDate: logSummary.startDate,
      endDate: logSummary.endDate,
      totalReturn: logSummary.totalGeometricReturn,
      totalLogReturn: logSummary.totalLogReturn,
      alpha: logSummary.alpha,
      byFactor: logSummary.byFactor.map((b) => ({
        code: b.code,
        label: b.label,
        contribution: b.contribution,
      })),
    };
  }

  // Simple mode, or log requested but unavailable → use the simple bucket.
  if (simpleSummary && simpleSummary.byFactor.length > 0) {
    return {
      isLog: false,
      label: simpleSummary.label,
      startDate: simpleSummary.startDate,
      endDate: simpleSummary.endDate,
      totalReturn: simpleSummary.totalReturn,
      totalLogReturn: null,
      alpha: simpleSummary.alpha,
      byFactor: simpleSummary.byFactor.map((b) => ({
        code: b.code,
        label: b.label,
        contribution: b.contribution,
      })),
    };
  }

  // Log requested + available but simple empty: still allow log even if we
  // skipped it above because mode was simple.
  if (logSummary && logSummary.byFactor.length > 0) {
    return {
      isLog: true,
      label: logSummary.label,
      startDate: logSummary.startDate,
      endDate: logSummary.endDate,
      totalReturn: logSummary.totalGeometricReturn,
      totalLogReturn: logSummary.totalLogReturn,
      alpha: logSummary.alpha,
      byFactor: logSummary.byFactor.map((b) => ({
        code: b.code,
        label: b.label,
        contribution: b.contribution,
      })),
    };
  }

  return null;
}

/** Live 1D poll response shape from `/api/analysis/factors/attribution/live-1d`. */
export interface PortfolioLive1DResponse {
  live: true;
  summary: PeriodAttributionSummary;
  summaryLog: PeriodAttributionSummaryLog | null;
  live1D: {
    asOf: string;
    session: import("@/lib/market-map/market-session").MarketSession;
    missingLegs: string[];
    factorsUsed: FactorCode[];
    missingHoldings: string[];
  };
}

function summaryToPicked(
  summary: PeriodAttributionSummary,
  isLog: false,
): PickedPeriodSummary;
function summaryToPicked(
  summary: PeriodAttributionSummaryLog,
  isLog: true,
): PickedPeriodSummary;
function summaryToPicked(
  summary: PeriodAttributionSummary | PeriodAttributionSummaryLog,
  isLog: boolean,
): PickedPeriodSummary {
  if (isLog) {
    const log = summary as PeriodAttributionSummaryLog;
    return {
      isLog: true,
      label: log.label,
      startDate: log.startDate,
      endDate: log.endDate,
      totalReturn: log.totalGeometricReturn,
      totalLogReturn: log.totalLogReturn,
      alpha: log.alpha,
      byFactor: log.byFactor.map((b) => ({
        code: b.code,
        label: b.label,
        contribution: b.contribution,
      })),
    };
  }
  const simple = summary as PeriodAttributionSummary;
  return {
    isLog: false,
    label: simple.label,
    startDate: simple.startDate,
    endDate: simple.endDate,
    totalReturn: simple.totalReturn,
    totalLogReturn: null,
    alpha: simple.alpha,
    byFactor: simple.byFactor.map((b) => ({
      code: b.code,
      label: b.label,
      contribution: b.contribution,
    })),
  };
}

/**
 * When a live 1D poll succeeds, override the static 1D bucket so the
 * portfolio waterfall matches the per-stock live path.
 */
export function mergeLive1DPeriodSummary(
  base: PickedPeriodSummary | null,
  period: FactorPeriod,
  mode: FactorAttributionMode,
  live: PortfolioLive1DResponse | null | undefined,
): PickedPeriodSummary | null {
  if (period !== "1D" || !live?.live) return base;

  const preferLog = mode === "log";
  if (preferLog && live.summaryLog) {
    return summaryToPicked(live.summaryLog, true);
  }
  return summaryToPicked(live.summary, false);
}
