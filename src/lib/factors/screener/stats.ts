/**
 * Cohort statistics builder for the per-stock screener.
 *
 * Computes mean / SD / sorted values per (cohort, column) over the rows that
 * passed the filter step AND, for columns subject to the significance gate,
 * over the cells whose |t| ≥ threshold. Columns whose values are gated for a
 * given row contribute nothing to that column's stats — so the cohort stats
 * the user sees percentiles and z-scores ranked against match the cells
 * actually visible in the grid.
 */
import type { FactorCode } from "@/types/factors";
import type {
  PerStockFactorCell,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type {
  FactorAttributionMode,
  FactorGridMetric,
  FactorScreenerFilters,
} from "@/store/analysis";
import type {
  ScreenerColumnKey,
  ScreenerColumnStats,
  ScreenerStats,
  ScreenerSummaryKey,
} from "./types";

/**
 * Pull the value the screener should rank/z-score for a factor cell under
 * the active metric. Mirrors `pickValue` in PerStockGrid but lives here so
 * pipeline + grid stay in sync.
 */
export function factorCellValue(
  cell: PerStockFactorCell | undefined,
  metric: FactorGridMetric,
): number | null {
  if (!cell) return null;
  const v =
    metric === "beta"
      ? cell.beta
      : metric === "return"
        ? cell.returnContribution
        : cell.riskContribution;
  return Number.isFinite(v) ? v : null;
}

/**
 * Pull the screener-relevant value for a summary column under the active
 * attribution mode.
 *
 * For Alpha and Unexplained the screener always ranks Σα / Σε (the rolling
 * post-burn-in sum). T and CI representations of those columns are
 * presentation-only and don't change cohort identity; the cohort needs a
 * single canonical "what is this row's α / ε for ranking" number.
 *
 * Mode-routing: when `mode === "log"` (the default), Alpha and Unexplained
 * read from `rollingAlphaPostBurnSumLog` / `rollingResidualPostBurnSumLog`
 * so the grid number lines up with the per-stock waterfall's prominent
 * log-space segment. R² and Vol are mode-invariant.
 *
 * `totalReturn` is the realized total stock return over the active
 * Attribution Period — `exp(Σ ln(1 + r_stock_t)) − 1` over the period's
 * date range. Pure price quantity (dividend-inclusive via adjClose), so
 * it matches the stock price chart's headline over the same dates and is
 * independent of the regression's beta / alpha / residual split. The
 * per-stock route's `applyPeriodOverlay` writes the period-sliced value
 * onto `row.realizedTotalReturn`; without a period overlay the row carries
 * the full-window value. Mode-invariant.
 */
export function summaryColumnValue(
  row: PerStockRow,
  key: ScreenerSummaryKey,
  mode: FactorAttributionMode = "log",
): number | null {
  if (key === "totalReturn") {
    const v = row.realizedTotalReturn;
    return v != null && Number.isFinite(v) ? v : null;
  }
  let v: number | null;
  if (key === "rSquared") v = row.rSquared;
  else if (key === "realizedVol") v = row.realizedAnnualizedVol;
  else if (key === "alpha") {
    v = mode === "log" ? row.rollingAlphaPostBurnSumLog : row.rollingAlphaPostBurnSum;
  } else {
    // residual
    v = mode === "log"
      ? row.rollingResidualPostBurnSumLog
      : row.rollingResidualPostBurnSum;
  }
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

/**
 * Extract the t-statistic governing the significance gate for a column on
 * a row, under the active attribution mode. Returns null when the column
 * has no t-stat (R², Vol — never gated).
 *
 * Alpha and residual t-stats route on `mode`; factor-cell t-stats are
 * mode-invariant (the cell-level OLS is the same in either path; the
 * mode toggle only affects the waterfall / summary aggregates).
 */
export function columnTStat(
  row: PerStockRow,
  key: ScreenerColumnKey,
  mode: FactorAttributionMode = "log",
): number | null {
  if (key === "rSquared" || key === "realizedVol" || key === "totalReturn") return null;
  if (key === "alpha") {
    const t = mode === "log" ? row.alphaTStatLog : row.alphaTStat;
    return t != null && Number.isFinite(t) ? t : null;
  }
  if (key === "residual") {
    const t = mode === "log" ? row.residualTStatLog : row.residualTStat;
    return t != null && Number.isFinite(t) ? t : null;
  }
  // Factor cell.
  const cell = row.cells[key as FactorCode];
  if (!cell) return null;
  return Number.isFinite(cell.tStat) ? cell.tStat : null;
}

/** Returns true when the cell on this row+column is masked by the sig gate. */
export function sigGatePassed(
  row: PerStockRow,
  key: ScreenerColumnKey,
  filters: FactorScreenerFilters,
  mode: FactorAttributionMode = "log",
): boolean {
  if (!filters.sigGate.enabled) return true;
  const t = columnTStat(row, key, mode);
  if (t === null) return true; // R²/Vol never gated
  return Math.abs(t) >= filters.sigGate.threshold;
}

/**
 * Build cohort × column stats over the surviving rows.
 *
 * Caller passes:
 *   - rows: surviving rows (post row-filter)
 *   - keyByTicker: cohort assignment from {@link assignCohorts}
 *   - factorColumns: which factor columns to include
 *   - summaryColumns: which summary columns to include
 *   - metric: active factor metric (β / return / risk)
 *   - filters: needed to apply the sig-gate cell mask before contributing
 *
 * Returned map: cohortKey → columnKey → stats.
 */
export function buildCohortStats(args: {
  rows: ReadonlyArray<PerStockRow>;
  keyByTicker: Map<string, string>;
  factorColumns: ReadonlyArray<FactorCode>;
  summaryColumns: ReadonlyArray<ScreenerSummaryKey>;
  metric: FactorGridMetric;
  filters: FactorScreenerFilters;
  /** Attribution mode — routes Alpha / Unexplained columns to log or simple space. */
  mode?: FactorAttributionMode;
}): ScreenerStats {
  const {
    rows,
    keyByTicker,
    factorColumns,
    summaryColumns,
    metric,
    filters,
    mode = "log",
  } = args;
  // Working accumulator: cohort → column → number[]
  const buckets = new Map<string, Map<ScreenerColumnKey, number[]>>();

  function push(cohort: string, col: ScreenerColumnKey, v: number) {
    let inner = buckets.get(cohort);
    if (!inner) {
      inner = new Map();
      buckets.set(cohort, inner);
    }
    let arr = inner.get(col);
    if (!arr) {
      arr = [];
      inner.set(col, arr);
    }
    arr.push(v);
  }

  for (const row of rows) {
    const cohort = keyByTicker.get(row.ticker);
    if (!cohort) continue;

    for (const sk of summaryColumns) {
      const v = summaryColumnValue(row, sk, mode);
      if (v === null) continue;
      // Sig-gate masks alpha and residual (their t-stats apply); R² and Vol
      // pass through unconditionally.
      if (!sigGatePassed(row, sk, filters, mode)) continue;
      push(cohort, sk, v);
    }

    for (const code of factorColumns) {
      const v = factorCellValue(row.cells[code], metric);
      if (v === null) continue;
      if (!sigGatePassed(row, code, filters, mode)) continue;
      push(cohort, code, v);
    }
  }

  // Materialise stats from each bucket.
  const out: ScreenerStats = new Map();
  for (const [cohort, cols] of buckets) {
    const inner = new Map<ScreenerColumnKey, ScreenerColumnStats>();
    for (const [col, arr] of cols) {
      inner.set(col, summarise(arr));
    }
    out.set(cohort, inner);
  }
  return out;
}

function summarise(values: number[]): ScreenerColumnStats {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0,
      mean: Number.NaN,
      sd: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
      sortedValues: [],
    };
  }
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  const sd = n >= 2 ? Math.sqrt(sumSq / (n - 1)) : Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    n,
    mean,
    sd,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    sortedValues: sorted,
  };
}

/** Convenience: look up stats with both lookups baked in. */
export function statsFor(
  stats: ScreenerStats,
  cohort: string,
  column: ScreenerColumnKey,
): ScreenerColumnStats | null {
  return stats.get(cohort)?.get(column) ?? null;
}
