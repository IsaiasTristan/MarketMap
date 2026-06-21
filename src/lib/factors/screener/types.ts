/**
 * Shared types for the per-stock factor screener pipeline.
 *
 * Pipeline order (each step strictly depends on the previous):
 *
 *   1. applyRowFilters(rows, filters)        — drop rows failing predicates
 *   2. assignCohorts(rows, refGroup)          — partition surviving rows
 *   3. buildCohortStats(rows, keyByTicker)    — mean / sd / sorted values
 *   4. computeZ / computePct / sigGatePassed  — derived per-cell numerics
 *   5. sort                                    — NaN to bottom, ticker tiebreak
 *
 * Cohort statistics are computed on the SURVIVING rows only — percentile and
 * z-score ranks reflect the filtered population the user actually sees.
 *
 * The sig gate is a cell-level mask, NOT a row predicate: a row stays in the
 * grid even if all of its factor cells fail |t| ≥ threshold; gated cells
 * render as a muted "·" and are excluded from sort + cohort stats on those
 * columns.
 */
import type { FactorCode } from "@/types/factors";
import type { PerStockRow } from "@/server/services/factor-per-stock.service";

/**
 * Sticky-column summary keys.
 *
 * `totalReturn` is the realized total stock return over the active
 * Attribution Period: `exp(Σ ln(1 + r_stock_t)) − 1` over the period's
 * date range. Pure price quantity computed directly from adjClose
 * (dividend-inclusive), so it matches the stock price chart's headline
 * over the same dates and is independent of the regression's beta /
 * alpha / residual split. Sourced from `row.realizedTotalReturn`, which
 * the per-stock route's `applyPeriodOverlay` writes from the active
 * period's slice (or the full-window value when no period is active).
 * Mode-invariant.
 */
export type ScreenerSummaryKey =
  | "totalReturn"
  | "rSquared"
  | "realizedVol"
  | "alpha"
  | "residual";

/** Any column the screener can rank, gate, or compute cohort stats over. */
export type ScreenerColumnKey = ScreenerSummaryKey | FactorCode;

/** Cohort statistics for a single (cohort, column) pair. */
export interface ScreenerColumnStats {
  /** Number of non-null observations contributing to the stats. */
  n: number;
  /** Sample mean. NaN when n === 0. */
  mean: number;
  /** Bessel-corrected sample SD. NaN when n < 2. */
  sd: number;
  /**
   * Min / max of the contributing values. Used to detect "essentially constant"
   * cohorts where z-score is meaningless and we fall back to percentile.
   */
  min: number;
  max: number;
  /**
   * Sorted ascending list of contributing values. Used to compute percentile
   * rank without re-sorting per query. Length equals `n`.
   */
  sortedValues: number[];
}

/** Reasons a row was dropped by the filter step (used in tooltips / debug). */
export type ScreenerDropReason =
  | "minRSquared"
  | "minObservations"
  | "alphaMagnitudeFloor"
  | "betaMagnitudeFloor"
  | "alphaCiExcludesZero";

export interface ScreenerFilteredRows {
  /** Rows that survived every active filter, original order preserved. */
  surviving: PerStockRow[];
  /** Reason map for each dropped row, keyed by ticker. */
  dropped: Map<string, ScreenerDropReason>;
}

/** Result of cohort assignment. */
export interface ScreenerCohorts {
  /** Cohort key per ticker (e.g. "sector:Energy", "subTheme:Software", "universe"). */
  keyByTicker: Map<string, string>;
  /**
   * Per-ticker widening trace: when a sub-theme had < MIN_COHORT_SIZE rows we
   * walked one step up (sub-theme → sector → universe). Tooltips read this so
   * users know the actual reference group used.
   */
  widenedFromTo: Map<string, { from: string; to: string }>;
  /** Number of rows in each cohort. */
  sizeByKey: Map<string, number>;
}

/** Cohort stats keyed by cohort then by column. */
export type ScreenerStats = Map<string, Map<ScreenerColumnKey, ScreenerColumnStats>>;

/** Result of a z-score lookup. */
export interface ScreenerZResult {
  /** Raw (unclipped) z-score. null when stats are unavailable. */
  raw: number | null;
  /** Display value: clipped to ±Z_DISPLAY_CLIP. null when raw is null. */
  display: number | null;
  /**
   * True when `σ_cohort` was below the absolute floor and the caller should
   * render a percentile instead. The clip flag and `display` are still
   * populated for backward use, but UI should defer to the percentile path
   * when this is true (and surface "Z fell back to Pct" in the tooltip).
   */
  fellBackToPct: boolean;
}
