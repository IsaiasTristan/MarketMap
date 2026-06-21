"use client";
import { useMemo, useState } from "react";
import {
  dimHeatColor,
  heatPercentileBloomberg,
  heatSignedBloomberg,
  heatTStatBloomberg,
} from "@/domain/calculations/heatmap";
import {
  useAnalysisStore,
  type FactorAttributionMode,
  type FactorGridMetric,
  type FactorGridStat,
  type FactorScreenerFilters,
} from "@/store/analysis";
import type {
  PerStockResult,
  PerStockFactorCell,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { getMetricDef } from "@/lib/factors/definitions/metric-defs";
import {
  applyRowFilters,
  assignCohorts,
  buildCohortStats,
  computePctFraction,
  computePctRank,
  computeZ,
  describeCohortKey,
  factorCellValue as screenerFactorCellValue,
  makeRowComparator,
  sigGatePassed,
  statsFor,
  summaryColumnValue as screenerSummaryColumnValue,
  Z_DISPLAY_CLIP,
  type ScreenerColumnKey,
  type ScreenerColumnStats,
  type ScreenerSummaryKey,
} from "@/lib/factors/screener";
import {
  BB_GRID_BORDER,
  BB_GRID_COL_WIDTH,
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  BB_GRID_HEADER_BG,
  BB_GRID_HEADER_COLOR,
  BB_GRID_HEADER_FONT_SIZE,
  BB_GRID_HEADER_FONT_WEIGHT,
  BB_GRID_HEADER_LETTER_SPACING,
  BB_GRID_HEADER_WRAP_FONT_SIZE,
  BB_GRID_META_FONT_SIZE,
  pickTextColor,
} from "../shared/bloomberg-grid";
import { HeaderDistributionStrip } from "../shared/HeaderDistributionStrip";
import { FactorTooltip } from "../shared/FactorTooltip";

interface PerStockGridProps {
  data: PerStockResult;
  metric: FactorGridMetric;
  /**
   * Active stat lens. `value` shows the raw metric (β / return / risk for
   * factor cells, Σα for alpha, Σε for residual). `t` shows the t-statistic.
   * `ci` shows the 95 % CI half-width. `t` and `ci` reuse the same |t|-keyed
   * heat ramp because |T| = |value| / (CI / 1.96).
   */
  stat: FactorGridStat;
  /** Tickers that currently have a floating detail panel open. */
  openTickers: ReadonlyArray<string>;
  onOpenTicker: (ticker: string) => void;
  onCloseTicker: (ticker: string) => void;
  /**
   * Controlled sort state. Lifted to the parent so external triggers
   * (e.g. clicking a sector × factor heatmap cell) can drive the grid's
   * sort. The grid still owns the click cycle (none → desc → asc → none)
   * but emits the next state via `onSortChange`.
   */
  sortBy: PerStockGridSort | null;
  onSortChange: (next: PerStockGridSort | null) => void;
  /**
   * Tickers brushed in the scatter panel. When non-empty, the grid pins
   * those rows to the top in the active sort order with a visible divider
   * separating the selection from the remaining rows.
   */
  selectedTickers: ReadonlySet<string>;
}

export interface PerStockGridSort {
  key: PerStockGridSortKey;
  dir: "asc" | "desc";
}

/**
 * Click cycle: none → desc → asc → none. Pulled out so external callers
 * (heatmap, scatter brush) can replicate the same convention if needed.
 */
function cycleSort(
  prev: PerStockGridSort | null,
  key: PerStockGridSortKey,
): PerStockGridSort | null {
  if (!prev || prev.key !== key) return { key, dir: "desc" };
  if (prev.dir === "desc") return { key, dir: "asc" };
  return null;
}

type SummarySortKey = ScreenerSummaryKey;
export type PerStockGridSortKey =
  | "ticker"
  | "sector"
  | SummarySortKey
  | FactorCode;

function pickValue(cell: PerStockFactorCell | undefined, metric: FactorGridMetric): number | null {
  if (!cell) return null;
  if (metric === "beta") return cell.beta;
  if (metric === "return") return cell.returnContribution;
  return cell.riskContribution;
}

function formatValue(v: number | null, metric: FactorGridMetric): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (metric === "beta") return v.toFixed(2);
  if (metric === "return") return `${(v * 100).toFixed(1)}%`;
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * 95 % CI half-width on whichever value the cell is showing.
 * `SE(β) = |β / T|`, so for β-metric CI = 1.96 × SE(β). Return contribution
 * is `β × Σr_t`, linear in β, so its CI = 1.96 × |β/T| × Σr_t = 1.96 × |RC/T|.
 * Risk metric is non-linear in β — caller never reaches this path because
 * the toolbar disables the combination.
 */
function ciHalfFromValueAndT(value: number, tStat: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(tStat)) return null;
  if (Math.abs(tStat) < 1e-9) return null;
  return Math.abs(value / tStat) * 1.96;
}

/** Heat direction for a column under the cohort-percentile ramp. */
function summaryHeatDirection(key: SummarySortKey): "signed" | "moreGreen" | "moreRed" {
  if (key === "rSquared") return "moreGreen";
  if (key === "realizedVol") return "moreRed";
  // totalReturn, alpha, residual — green up / red down
  return "signed";
}

function factorHeatDirection(metric: FactorGridMetric): "signed" | "moreGreen" | "moreRed" {
  // Risk PCR is signed (negative covariance contributions exist), beta and
  // return contribs are signed too. Always signed for factor cells.
  void metric;
  return "signed";
}

/**
 * Format a Z-score for display: 1 dp with explicit sign. Display is already
 * clipped to ±Z_DISPLAY_CLIP by the screener pipeline.
 */
function formatZ(v: number): string {
  if (v >= 0) return `+${v.toFixed(1)}`;
  return v.toFixed(1);
}

/** Format a percentile rank (1-99 integer) for display. */
function formatPct(v: number): string {
  return `${v}`;
}

interface CellRender {
  text: string;
  bg: string;
  color: string;
  /** Sort key (null sorts to bottom regardless of direction). */
  sortKey: number | null;
  /** True when the sig gate masked this cell. Visual: muted "·". */
  gated: boolean;
  /** True when z-mode fell back to percentile. Tooltip flag. */
  fallbackPct: boolean;
  /** Tooltip suffix appended to the cell title. */
  tooltipExtra?: string;
}

function emptyCellRender(): CellRender {
  return {
    text: "—",
    bg: "rgba(255,255,255,0.02)",
    color: "var(--text-muted)",
    sortKey: null,
    gated: false,
    fallbackPct: false,
  };
}

function gatedCellRender(threshold: number): CellRender {
  return {
    text: "·",
    bg: "rgba(255,255,255,0.02)",
    color: "var(--text-muted)",
    sortKey: null,
    gated: true,
    fallbackPct: false,
    tooltipExtra: `Cell masked by significance gate (|t| < ${threshold.toFixed(1)}).`,
  };
}

/**
 * Render a factor cell under the active (metric, stat) lens, using cohort
 * stats from the screener pipeline. Returns text, heat color, sort key, and
 * gate / fallback flags so the grid can render and sort with one lookup.
 */
function renderFactorCell(
  cell: PerStockFactorCell | undefined,
  row: PerStockRow,
  code: FactorCode,
  metric: FactorGridMetric,
  stat: FactorGridStat,
  cohortStats: ScreenerColumnStats | null,
  filters: FactorScreenerFilters,
): CellRender {
  // Sig gate is universal — every stat lens hides masked cells the same way.
  if (filters.sigGate.enabled && !sigGatePassed(row, code, filters)) {
    return gatedCellRender(filters.sigGate.threshold);
  }

  if (stat === "t") {
    if (!cell || !Number.isFinite(cell.tStat)) return emptyCellRender();
    const bg = heatTStatBloomberg(cell.tStat);
    return {
      text: cell.tStat.toFixed(2),
      bg,
      color: pickTextColor(bg),
      sortKey: Math.abs(cell.tStat),
      gated: false,
      fallbackPct: false,
    };
  }
  if (stat === "ci") {
    if (!cell || metric === "risk") return emptyCellRender();
    const base = pickValue(cell, metric);
    if (base === null) return emptyCellRender();
    const ci = ciHalfFromValueAndT(base, cell.tStat);
    if (ci === null) return emptyCellRender();
    const text = metric === "beta" ? `±${ci.toFixed(2)}` : `±${(ci * 100).toFixed(1)}%`;
    const bg = heatTStatBloomberg(cell.tStat);
    return {
      text,
      bg,
      color: pickTextColor(bg),
      sortKey: ci,
      gated: false,
      fallbackPct: false,
    };
  }
  if (stat === "z") {
    const v = screenerFactorCellValue(cell, metric);
    const z = computeZ(v, cohortStats);
    if (z.fellBackToPct) {
      const pct = computePctRank(v, cohortStats);
      if (pct === null) return emptyCellRender();
      const bg = heatPercentileBloomberg(pct / 100, factorHeatDirection(metric));
      return {
        text: `P${formatPct(pct)}`,
        bg,
        color: pickTextColor(bg),
        sortKey: pct,
        gated: false,
        fallbackPct: true,
        tooltipExtra: "Z-score fell back to percentile (cohort essentially constant).",
      };
    }
    if (z.display === null || z.raw === null) return emptyCellRender();
    const bg = heatSignedBloomberg(z.display, 3);
    return {
      text: formatZ(z.display),
      bg,
      color: pickTextColor(bg),
      sortKey: z.raw,
      gated: false,
      fallbackPct: false,
      tooltipExtra:
        Math.abs(z.raw) > Z_DISPLAY_CLIP
          ? `Raw z = ${z.raw.toFixed(2)} (clipped to ±${Z_DISPLAY_CLIP} for display).`
          : undefined,
    };
  }
  if (stat === "pct") {
    const v = screenerFactorCellValue(cell, metric);
    const pct = computePctRank(v, cohortStats);
    if (pct === null) return emptyCellRender();
    const bg = heatPercentileBloomberg(pct / 100, factorHeatDirection(metric));
    return {
      text: formatPct(pct),
      bg,
      color: pickTextColor(bg),
      sortKey: pct,
      gated: false,
      fallbackPct: false,
    };
  }
  // stat === "value"
  const v = screenerFactorCellValue(cell, metric);
  if (v === null) return emptyCellRender();
  const text = formatValue(v, metric);
  const pct = computePctFraction(v, cohortStats);
  const bg =
    pct !== null
      ? heatPercentileBloomberg(pct, factorHeatDirection(metric))
      : "rgba(255,255,255,0.02)";
  return {
    text,
    bg,
    color: pickTextColor(bg),
    sortKey: v,
    gated: false,
    fallbackPct: false,
  };
}

/**
 * Render a summary cell. R² and Vol have stat-invariant value lookups
 * (always show their raw decimal); Alpha and Unexplained switch number
 * representation by stat (Σ value / t-stat / CI half-width / z / pct) AND
 * by attribution mode (log vs simple — Σα and Σε are different quantities
 * in the two spaces, by Jensen's correction on each day's residual).
 */
function renderSummaryCell(
  row: PerStockRow,
  key: SummarySortKey,
  stat: FactorGridStat,
  cohortStats: ScreenerColumnStats | null,
  filters: FactorScreenerFilters,
  rowAllFactorsGated: boolean,
  mode: FactorAttributionMode,
): CellRender {
  // Sig gate applies to alpha + residual via their own t-stats; R² and Vol
  // are never gated (they have no t-stat). Row-level dimming below.
  if (filters.sigGate.enabled && !sigGatePassed(row, key, filters, mode)) {
    return gatedCellRender(filters.sigGate.threshold);
  }

  const direction = summaryHeatDirection(key);

  // Raw value for cohort-relative stats (same as screener pipeline).
  const valueRaw = screenerSummaryColumnValue(row, key, mode);

  // Total Return — stat-invariant signed % over the active Attribution
  // Period. Always shows the realized total stock return (price-based,
  // geometric, dividend-inclusive) regardless of the Stat toggle. No
  // t-stat or CI applies to a single price-based quantity. Heat ramp is
  // signed (green up / red down).
  if (key === "totalReturn") {
    if (valueRaw === null) return emptyCellRender();
    const sign = valueRaw >= 0 ? "+" : "";
    const text = `${sign}${(valueRaw * 100).toFixed(1)}%`;
    if (stat === "z") {
      const z = computeZ(valueRaw, cohortStats);
      if (z.fellBackToPct) {
        const pct = computePctRank(valueRaw, cohortStats);
        if (pct === null) return emptyCellRender();
        const bg = heatPercentileBloomberg(pct / 100, direction);
        return {
          text: `P${formatPct(pct)}`,
          bg: rowAllFactorsGated ? dimHeatColor() : bg,
          color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
          sortKey: pct,
          gated: false,
          fallbackPct: true,
          tooltipExtra: "Z-score fell back to percentile (cohort essentially constant).",
        };
      }
      if (z.display === null || z.raw === null) return emptyCellRender();
      const bg = heatSignedBloomberg(z.display, 3);
      return {
        text: formatZ(z.display),
        bg: rowAllFactorsGated ? dimHeatColor() : bg,
        color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
        sortKey: z.raw,
        gated: false,
        fallbackPct: false,
      };
    }
    if (stat === "pct") {
      const pct = computePctRank(valueRaw, cohortStats);
      if (pct === null) return emptyCellRender();
      const bg = heatPercentileBloomberg(pct / 100, direction);
      return {
        text: formatPct(pct),
        bg: rowAllFactorsGated ? dimHeatColor() : bg,
        color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
        sortKey: pct,
        gated: false,
        fallbackPct: false,
      };
    }
    // value / t / ci — stat-invariant for a composite sum.
    const pct = computePctFraction(valueRaw, cohortStats);
    const bg =
      pct !== null
        ? heatPercentileBloomberg(pct, direction)
        : "rgba(255,255,255,0.02)";
    return {
      text,
      bg: rowAllFactorsGated ? dimHeatColor() : bg,
      color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
      sortKey: valueRaw,
      gated: false,
      fallbackPct: false,
    };
  }

  if (key === "rSquared" || key === "realizedVol") {
    if (valueRaw === null) return emptyCellRender();
    if (stat === "z") {
      const z = computeZ(valueRaw, cohortStats);
      if (z.fellBackToPct) {
        const pct = computePctRank(valueRaw, cohortStats);
        if (pct === null) return emptyCellRender();
        const bg = heatPercentileBloomberg(pct / 100, direction);
        return {
          text: `P${formatPct(pct)}`,
          bg: rowAllFactorsGated ? dimHeatColor() : bg,
          color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
          sortKey: pct,
          gated: false,
          fallbackPct: true,
          tooltipExtra: "Z-score fell back to percentile (cohort essentially constant).",
        };
      }
      if (z.display === null || z.raw === null) return emptyCellRender();
      const bg = heatSignedBloomberg(z.display, 3);
      return {
        text: formatZ(z.display),
        bg: rowAllFactorsGated ? dimHeatColor() : bg,
        color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
        sortKey: z.raw,
        gated: false,
        fallbackPct: false,
      };
    }
    if (stat === "pct") {
      const pct = computePctRank(valueRaw, cohortStats);
      if (pct === null) return emptyCellRender();
      const bg = heatPercentileBloomberg(pct / 100, direction);
      return {
        text: formatPct(pct),
        bg: rowAllFactorsGated ? dimHeatColor() : bg,
        color: pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
        sortKey: pct,
        gated: false,
        fallbackPct: false,
      };
    }
    // value / t / ci → R² and Vol are stat-invariant
    const text = `${(valueRaw * 100).toFixed(key === "rSquared" ? 0 : 1)}%`;
    const pct = computePctFraction(valueRaw, cohortStats);
    const bg =
      pct !== null
        ? heatPercentileBloomberg(pct, direction)
        : "rgba(255,255,255,0.02)";
    const lowFit = key === "rSquared" && valueRaw < 0.3;
    return {
      text,
      bg: rowAllFactorsGated ? dimHeatColor() : bg,
      color: lowFit
        ? "var(--text-muted)"
        : pickTextColor(rowAllFactorsGated ? dimHeatColor() : bg),
      sortKey: valueRaw,
      gated: false,
      fallbackPct: false,
    };
  }

  // Alpha or Unexplained — stat-aware AND mode-aware rendering. The t / CI
  // branches read mode-routed t-stat fields so the heat ramp lines up with
  // the value the user sees in `value` mode.
  if (stat === "t") {
    let tStat: number;
    if (key === "alpha") {
      const t = mode === "log" ? row.alphaTStatLog : row.alphaTStat;
      tStat = t != null && Number.isFinite(t) ? t : Number.NaN;
    } else {
      const t = mode === "log" ? row.residualTStatLog : row.residualTStat;
      tStat = t != null && Number.isFinite(t) ? t : Number.NaN;
    }
    if (!Number.isFinite(tStat)) return emptyCellRender();
    const bg = heatTStatBloomberg(tStat);
    return {
      text: tStat.toFixed(2),
      bg,
      color: pickTextColor(bg),
      sortKey: Math.abs(tStat),
      gated: false,
      fallbackPct: false,
    };
  }
  if (stat === "ci") {
    let ci: number | null;
    let tStat: number;
    if (key === "alpha") {
      ci = mode === "log" ? row.alphaCi95HalfLog : row.alphaCi95Half;
      const t = mode === "log" ? row.alphaTStatLog : row.alphaTStat;
      tStat = t != null && Number.isFinite(t) ? t : Number.NaN;
    } else {
      ci = mode === "log" ? row.residualCi95HalfLog : row.residualCi95Half;
      const t = mode === "log" ? row.residualTStatLog : row.residualTStat;
      tStat = t != null && Number.isFinite(t) ? t : Number.NaN;
    }
    if (ci == null || !Number.isFinite(ci) || ci <= 0) return emptyCellRender();
    const bg = Number.isFinite(tStat)
      ? heatTStatBloomberg(tStat)
      : "rgba(255,255,255,0.02)";
    return {
      text: `±${(ci * 100).toFixed(1)}%`,
      bg,
      color: pickTextColor(bg),
      sortKey: ci,
      gated: false,
      fallbackPct: false,
    };
  }
  if (stat === "z") {
    const z = computeZ(valueRaw, cohortStats);
    if (z.fellBackToPct) {
      const pct = computePctRank(valueRaw, cohortStats);
      if (pct === null) return emptyCellRender();
      const bg = heatPercentileBloomberg(pct / 100, direction);
      return {
        text: `P${formatPct(pct)}`,
        bg,
        color: pickTextColor(bg),
        sortKey: pct,
        gated: false,
        fallbackPct: true,
        tooltipExtra: "Z-score fell back to percentile (cohort essentially constant).",
      };
    }
    if (z.display === null || z.raw === null) return emptyCellRender();
    const bg = heatSignedBloomberg(z.display, 3);
    return {
      text: formatZ(z.display),
      bg,
      color: pickTextColor(bg),
      sortKey: z.raw,
      gated: false,
      fallbackPct: false,
    };
  }
  if (stat === "pct") {
    const pct = computePctRank(valueRaw, cohortStats);
    if (pct === null) return emptyCellRender();
    const bg = heatPercentileBloomberg(pct / 100, direction);
    return {
      text: formatPct(pct),
      bg,
      color: pickTextColor(bg),
      sortKey: pct,
      gated: false,
      fallbackPct: false,
    };
  }
  // stat === "value"
  if (valueRaw === null) return emptyCellRender();
  const sign = valueRaw >= 0 ? "+" : "";
  const text = `${sign}${(valueRaw * 100).toFixed(1)}%`;
  const pct = computePctFraction(valueRaw, cohortStats);
  const bg =
    pct !== null
      ? heatPercentileBloomberg(pct, direction)
      : "rgba(255,255,255,0.02)";
  return {
    text,
    bg,
    color: pickTextColor(bg),
    sortKey: valueRaw,
    gated: false,
    fallbackPct: false,
  };
}

// Single shared column width — see BB_GRID_COL_WIDTH for rationale.
const TICKER_COL_WIDTH = BB_GRID_COL_WIDTH;
const META_COL_WIDTH = BB_GRID_COL_WIDTH;
const SUMMARY_COL_WIDTH = BB_GRID_COL_WIDTH;
const FACTOR_COL_WIDTH = BB_GRID_COL_WIDTH;
// Min row height; rows grow taller automatically when sector / sub-theme
// labels wrap to two lines because we removed the fixed `height`.
const ROW_HEIGHT = 30;

// Order: Total Return | R² | Vol | Alpha | Unexplained.
// Total Return is the realized total stock return over the active
// Attribution Period (price-based, geometric, dividend-inclusive) — sits
// leftmost so the user reads it before drilling into the per-factor
// heatmap and matches the price chart over the same dates. R² and Vol
// come next as descriptive stats that don't change with the Stat toggle,
// then the two stat-aware columns whose content swaps between value /
// t-stat / CI based on `stat`.
const SUMMARY_KEYS: readonly SummarySortKey[] = [
  "totalReturn",
  "rSquared",
  "realizedVol",
  "alpha",
  "residual",
] as const;

const SUMMARY_LABELS: Record<SummarySortKey, string> = {
  totalReturn: "Total Return",
  rSquared: "R²",
  realizedVol: "Vol",
  alpha: "Alpha",
  residual: "Unexplained",
};

/**
 * Append " (log)" / " (simple)" suffix to alpha / residual headers so
 * the user can read at-a-glance which space the cell numbers are in.
 * R² and Vol are mode-invariant; no suffix.
 */
function summaryHeaderLabel(
  k: SummarySortKey,
  mode: FactorAttributionMode,
): string {
  if (k === "alpha" || k === "residual") {
    return `${SUMMARY_LABELS[k]} (${mode})`;
  }
  return SUMMARY_LABELS[k];
}

const headerCellStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: BB_GRID_HEADER_BG,
  color: BB_GRID_HEADER_COLOR,
  fontSize: BB_GRID_HEADER_WRAP_FONT_SIZE,
  fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
  letterSpacing: BB_GRID_HEADER_LETTER_SPACING,
  textTransform: "uppercase",
  padding: "2px 4px",
  borderRight: BB_GRID_BORDER,
  borderBottom: BB_GRID_BORDER,
  textAlign: "center",
  // Allow long labels (e.g. "Betting-Against-Beta", "Total Return",
  // "Unexplained (log)") to wrap onto two lines inside the uniform
  // BB_GRID_COL_WIDTH instead of clipping or expanding the column.
  whiteSpace: "normal",
  wordBreak: "break-word",
  lineHeight: 1.15,
  zIndex: 2,
};

const stickyLeftStyle: React.CSSProperties = {
  position: "sticky",
  left: 0,
  background: "var(--bg-surface)",
  borderRight: BB_GRID_BORDER,
  zIndex: 1,
};

function SortCaret({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return (
    <span style={{ color: "var(--color-accent)", marginLeft: 4, fontSize: 9 }}>
      {dir === "desc" ? "\u25BC" : "\u25B2"}
    </span>
  );
}

export function PerStockGrid({
  data,
  metric,
  stat,
  openTickers,
  onOpenTicker,
  onCloseTicker,
  sortBy,
  onSortChange,
  selectedTickers,
}: PerStockGridProps) {
  const openTickerSet = useMemo(() => new Set(openTickers), [openTickers]);
  const factors = data.usableFactors;

  // Screener state — drives row filtering, cohort partitioning, sig-gate.
  const filters = useAnalysisStore((s) => s.factorScreenerFilters);
  const refGroup = useAnalysisStore((s) => s.factorScreenerRefGroup);
  const screenerEnabled = useAnalysisStore((s) => s.factorScreenerEnabled);
  const histogramEnabled = useAnalysisStore(
    (s) => s.factorHeaderHistogramEnabled,
  );
  // Attribution mode routes Alpha and Unexplained columns between log-space
  // and simple-space rolling sums. Default is log (matches the per-stock
  // waterfall's prominent "Σ α_t (log)" segment); user can flip to simple
  // via the toolbar's Attr segmented control. See log-vs-simple Jensen note.
  const attributionMode = useAnalysisStore((s) => s.factorAttributionMode);
  // Active Attribution Period — surfaced in the Total Return header tooltip
  // so the user can see the date range the decomposition is summed over.
  const factorPeriod = useAnalysisStore((s) => s.factorPeriod);

  // Representative period date span (start → end) for the active period.
  // Drawn from the first row that carries a `periodSlices[period]` entry —
  // every row's slice starts/ends on the same trading-day boundaries, so
  // the first one is a faithful header-level summary. Falls back to null
  // when the cache predates `periodSlices` (rare; surfaces a generic
  // "(period dates unavailable)" hint in the tooltip).
  const periodDateSpan = useMemo((): { startDate: string; endDate: string } | null => {
    for (const r of data.rows) {
      const slice = r.periodSlices?.[factorPeriod];
      if (slice && slice.startDate && slice.endDate) {
        return { startDate: slice.startDate, endDate: slice.endDate };
      }
    }
    return null;
  }, [data.rows, factorPeriod]);

  // Hovered row drives the column-header histogram strip's tick + cohort
  // selection. We track ticker, not row identity, so multiple tickers in
  // the same cohort use the same precomputed stats (no extra memo churn).
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null);

  const onHeaderClick = (key: PerStockGridSortKey) => {
    onSortChange(cycleSort(sortBy, key));
  };

  // 1. Apply row predicate filters (sig gate is a cell mask, applied later).
  // 2. Assign cohorts on the surviving rows (universe / sector / sub-theme),
  //    widening tiny sub-theme cohorts up one level.
  // 3. Build cohort × column stats over surviving rows, with sig-gate masked
  //    cells excluded from the cohort distribution they're being ranked
  //    against — so percentiles match what the user sees.
  const screenerView = useMemo(() => {
    if (!screenerEnabled) {
      // Legacy mode: skip every screener step. Surviving rows = all rows,
      // cohort = "universe" by ticker, no stats means renderers fall back
      // to neutral heat. Effective "no screener" view.
      const surviving = data.rows;
      const keyByTicker = new Map<string, string>();
      for (const r of surviving) keyByTicker.set(r.ticker, "universe");
      return {
        surviving,
        dropped: new Map<string, never>(),
        cohorts: {
          keyByTicker,
          widenedFromTo: new Map(),
          sizeByKey: new Map([["universe", surviving.length]]),
        },
        stats: new Map() as ReturnType<typeof buildCohortStats>,
        rowAllFactorsGated: new Map<string, boolean>(),
        gatedCellsCount: 0,
        totalFactorCellsCount: 0,
      };
    }
    const { surviving, dropped } = applyRowFilters(data.rows, filters);
    const cohorts = assignCohorts(surviving, refGroup);
    const stats = buildCohortStats({
      rows: surviving,
      keyByTicker: cohorts.keyByTicker,
      factorColumns: factors,
      summaryColumns: SUMMARY_KEYS,
      metric,
      filters,
      mode: attributionMode,
    });
    // Per-row "every factor cell is gated" flag — drives summary heat dimming
    // so a row whose factors are all noise doesn't read as a high-quality fit
    // just because R² happens to be 0.5.
    const rowAllFactorsGated = new Map<string, boolean>();
    let gatedCells = 0;
    let totalFactorCells = 0;
    if (filters.sigGate.enabled) {
      for (const r of surviving) {
        let allGated = true;
        for (const code of factors) {
          const cell = r.cells[code];
          if (!cell) continue;
          totalFactorCells++;
          if (sigGatePassed(r, code, filters, attributionMode)) {
            allGated = false;
          } else {
            gatedCells++;
          }
        }
        rowAllFactorsGated.set(r.ticker, allGated);
      }
    } else {
      // Sig gate off: count totalFactorCells for footer parity, no gating.
      for (const r of surviving) {
        for (const code of factors) {
          if (r.cells[code]) totalFactorCells++;
        }
        rowAllFactorsGated.set(r.ticker, false);
      }
    }
    return {
      surviving,
      dropped,
      cohorts,
      stats,
      rowAllFactorsGated,
      gatedCellsCount: gatedCells,
      totalFactorCellsCount: totalFactorCells,
    };
  }, [data.rows, factors, metric, filters, refGroup, screenerEnabled, attributionMode]);

  // Pre-compute every cell render once — keyed by ticker, then column —
  // so sort, cell render, and tooltip composition each look up the same
  // pre-computed entry rather than recomputing.
  const cellRenders = useMemo(() => {
    const out = new Map<string, Map<ScreenerColumnKey, CellRender>>();
    for (const row of screenerView.surviving) {
      const cohort = screenerView.cohorts.keyByTicker.get(row.ticker) ?? "universe";
      const allGated = screenerView.rowAllFactorsGated.get(row.ticker) === true;
      const inner = new Map<ScreenerColumnKey, CellRender>();
      for (const sk of SUMMARY_KEYS) {
        const stats = statsFor(screenerView.stats, cohort, sk);
        inner.set(
          sk,
          renderSummaryCell(row, sk, stat, stats, filters, allGated, attributionMode),
        );
      }
      for (const code of factors) {
        const stats = statsFor(screenerView.stats, cohort, code);
        inner.set(
          code,
          renderFactorCell(row.cells[code], row, code, metric, stat, stats, filters),
        );
      }
      out.set(row.ticker, inner);
    }
    return out;
  }, [screenerView, factors, metric, stat, filters, attributionMode]);

  const sortedRows = useMemo(() => {
    const rows = [...screenerView.surviving];
    if (!sortBy) return rows;

    if (sortBy.key === "ticker") {
      rows.sort((a, b) => {
        const c = a.ticker.localeCompare(b.ticker);
        return sortBy.dir === "desc" ? -c : c;
      });
      return rows;
    }
    if (sortBy.key === "sector") {
      rows.sort((a, b) => {
        const sa = `${a.sector}\0${a.subTheme}`;
        const sb = `${b.sector}\0${b.subTheme}`;
        const c = sa.localeCompare(sb);
        if (c !== 0) return sortBy.dir === "desc" ? -c : c;
        return a.ticker.localeCompare(b.ticker);
      });
      return rows;
    }
    const colKey = sortBy.key as ScreenerColumnKey;
    const cmp = makeRowComparator<PerStockRow>(
      (r) => cellRenders.get(r.ticker)?.get(colKey)?.sortKey ?? null,
      (r) => r.ticker,
      sortBy.dir,
    );
    rows.sort(cmp);
    return rows;
  }, [screenerView.surviving, sortBy, cellRenders]);

  // Pin selected rows to the top above a divider, preserving the active
  // sort order within each group. Selection is sourced from the scatter
  // panel's brush; when it's empty the grid is just `sortedRows` as-is.
  const { pinnedRows, restRows } = useMemo(() => {
    if (!selectedTickers || selectedTickers.size === 0) {
      return { pinnedRows: [] as PerStockRow[], restRows: sortedRows };
    }
    const pinned: PerStockRow[] = [];
    const rest: PerStockRow[] = [];
    for (const r of sortedRows) {
      if (selectedTickers.has(r.ticker)) pinned.push(r);
      else rest.push(r);
    }
    return { pinnedRows: pinned, restRows: rest };
  }, [sortedRows, selectedTickers]);

  const factorStatusMap = useMemo(() => {
    const m = new Map<FactorCode, string>();
    for (const c of data.coverage) m.set(c.code, c.status);
    return m;
  }, [data.coverage]);

  // Universe-wide cohort stats — used by the header histogram strip for the
  // resting state when no row is hovered. When the active refGroup is
  // already "universe" the existing screenerView.stats serves both roles
  // and we skip the extra computation.
  const universeStats = useMemo(() => {
    if (!screenerEnabled || !histogramEnabled) return null;
    if (refGroup.kind === "universe") return screenerView.stats;
    const universeKey = new Map<string, string>();
    for (const r of screenerView.surviving) universeKey.set(r.ticker, "universe");
    return buildCohortStats({
      rows: screenerView.surviving,
      keyByTicker: universeKey,
      factorColumns: factors,
      summaryColumns: SUMMARY_KEYS,
      metric,
      filters,
      mode: attributionMode,
    });
  }, [
    screenerEnabled,
    histogramEnabled,
    refGroup.kind,
    screenerView.surviving,
    screenerView.stats,
    factors,
    metric,
    filters,
    attributionMode,
  ]);

  // Resolve the column-header strip's (stats, hoveredValue) pair based on
  // the hovered row. With no hover, fall back to universe stats so the
  // strip always has a stable resting visual.
  const stripDataFor = (
    column: ScreenerColumnKey,
  ): { stats: ScreenerColumnStats | null; hoveredValue: number | null } => {
    if (!screenerEnabled || !histogramEnabled) {
      return { stats: null, hoveredValue: null };
    }
    if (hoveredTicker) {
      const cohort =
        screenerView.cohorts.keyByTicker.get(hoveredTicker) ?? "universe";
      const stats = statsFor(screenerView.stats, cohort, column);
      const row = screenerView.surviving.find((r) => r.ticker === hoveredTicker);
      let hoveredValue: number | null = null;
      if (row) {
        if (
          column === "totalReturn" ||
          column === "rSquared" ||
          column === "realizedVol" ||
          column === "alpha" ||
          column === "residual"
        ) {
          hoveredValue = screenerSummaryColumnValue(row, column, attributionMode);
        } else {
          hoveredValue = screenerFactorCellValue(
            row.cells[column as FactorCode],
            metric,
          );
        }
      }
      return { stats, hoveredValue };
    }
    // Resting state: universe distribution.
    const stats = universeStats
      ? statsFor(universeStats, "universe", column)
      : null;
    return { stats, hoveredValue: null };
  };

  const headerButtonBase: React.CSSProperties = {
    width: "100%",
    height: "100%",
    margin: 0,
    padding: "5px 6px",
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "inherit",
    textTransform: "inherit",
    letterSpacing: "inherit",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  };

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        overflow: "auto",
        maxHeight: "calc(100vh - 280px)",
      }}
    >
      <table
        style={{
          borderCollapse: "separate",
          borderSpacing: 0,
          // tableLayout: fixed pins every column to its declared width so a
          // single long label can't push the rest of the grid out of rhythm.
          // Combined with BB_GRID_COL_WIDTH this makes ticker, sector, the
          // 5 summary columns, and all 14 factor columns the same width.
          tableLayout: "fixed",
          width: "max-content",
          fontSize: BB_GRID_FONT_SIZE,
          fontFamily: BB_GRID_FONT_STACK,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                ...headerCellStyle,
                ...stickyLeftStyle,
                left: 0,
                width: TICKER_COL_WIDTH,
                minWidth: TICKER_COL_WIDTH,
                color: BB_GRID_HEADER_COLOR,
                textAlign: "left",
                paddingLeft: 0,
                background: BB_GRID_HEADER_BG,
                zIndex: 3,
              }}
              role="columnheader"
              aria-sort={
                sortBy?.key === "ticker"
                  ? sortBy.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              <button
                type="button"
                onClick={() => onHeaderClick("ticker")}
                style={{ ...headerButtonBase, justifyContent: "flex-start", paddingLeft: 6 }}
                title="Sort by ticker"
              >
                Ticker
                <SortCaret active={sortBy?.key === "ticker"} dir={sortBy?.dir ?? "desc"} />
              </button>
            </th>
            <th
              style={{
                ...headerCellStyle,
                ...stickyLeftStyle,
                left: TICKER_COL_WIDTH,
                width: META_COL_WIDTH,
                minWidth: META_COL_WIDTH,
                color: BB_GRID_HEADER_COLOR,
                textAlign: "left",
                background: BB_GRID_HEADER_BG,
                zIndex: 3,
                padding: 0,
              }}
              role="columnheader"
              aria-sort={
                sortBy?.key === "sector"
                  ? sortBy.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              <button
                type="button"
                onClick={() => onHeaderClick("sector")}
                style={{ ...headerButtonBase, justifyContent: "flex-start", paddingLeft: 6 }}
                title="Sort by sector / sub-theme"
              >
                Sector / Sub-theme
                <SortCaret active={sortBy?.key === "sector"} dir={sortBy?.dir ?? "desc"} />
              </button>
            </th>
            {SUMMARY_KEYS.map((k, idx) => {
              const active = sortBy?.key === k;
              const md = getMetricDef(k);
              // Enrich the concise definition with the live period dates for
              // the Total Return column so the user can see exactly which dates
              // the return is measured over.
              const howCalc =
                k === "totalReturn" && periodDateSpan
                  ? `${md.howCalculated} Period (${factorPeriod}): ${periodDateSpan.startDate} → ${periodDateSpan.endDate}.`
                  : md.howCalculated;
              const isLastSummary = idx === SUMMARY_KEYS.length - 1;
              const stripData =
                screenerEnabled && histogramEnabled ? stripDataFor(k) : null;
              return (
                <th
                  key={`summary-${k}`}
                  style={{
                    ...headerCellStyle,
                    width: SUMMARY_COL_WIDTH,
                    minWidth: SUMMARY_COL_WIDTH,
                    color: BB_GRID_HEADER_COLOR,
                    padding: 0,
                    borderRight: isLastSummary
                      ? "2px solid var(--bg-border)"
                      : BB_GRID_BORDER,
                  }}
                  role="columnheader"
                  aria-sort={
                    active ? (sortBy!.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <button
                      type="button"
                      onClick={() => onHeaderClick(k)}
                      style={{
                        ...headerButtonBase,
                        color: "inherit",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <FactorTooltip
                        name={md.name}
                        definition={md.definition}
                        howCalculated={howCalc}
                        dataUsed={md.dataUsed}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {summaryHeaderLabel(k, attributionMode)}
                        </span>
                      </FactorTooltip>
                      <SortCaret active={active} dir={sortBy?.dir ?? "desc"} />
                    </button>
                    {stripData && (
                      <div style={{ padding: "0 4px 2px" }}>
                        <HeaderDistributionStrip
                          stats={stripData.stats}
                          hoveredValue={stripData.hoveredValue}
                          width={SUMMARY_COL_WIDTH - 8}
                        />
                      </div>
                    )}
                  </div>
                </th>
              );
            })}
            {factors.map((code) => {
              const def = getFactorDef(code);
              const status = factorStatusMap.get(code);
              const active = sortBy?.key === code;
              const stripData =
                screenerEnabled && histogramEnabled ? stripDataFor(code) : null;
              return (
                <th
                  key={code}
                  style={{
                    ...headerCellStyle,
                    width: FACTOR_COL_WIDTH,
                    minWidth: FACTOR_COL_WIDTH,
                    color: status === "OK" ? BB_GRID_HEADER_COLOR : "var(--color-warning, #f59e0b)",
                    padding: 0,
                  }}
                  role="columnheader"
                  aria-sort={
                    active ? (sortBy!.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <button
                      type="button"
                      onClick={() => onHeaderClick(code)}
                      title="Click to sort rows by this column"
                      style={{
                        ...headerButtonBase,
                        color: "inherit",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <FactorTooltip code={code} concise>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{def.shortLabel}</span>
                      </FactorTooltip>
                      <SortCaret active={active} dir={sortBy?.dir ?? "desc"} />
                    </button>
                    {stripData && (
                      <div style={{ padding: "0 4px 2px" }}>
                        <HeaderDistributionStrip
                          stats={stripData.stats}
                          hoveredValue={stripData.hoveredValue}
                          width={FACTOR_COL_WIDTH - 8}
                        />
                      </div>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody onMouseLeave={() => setHoveredTicker(null)}>
          {pinnedRows.length > 0 && (
            <tr key="__pin_label__">
              <td
                colSpan={factors.length + 2 + SUMMARY_KEYS.length}
                style={{
                  padding: "4px 12px",
                  background: "rgba(240,182,93,0.06)",
                  borderTop: "1px solid var(--color-accent)",
                  borderBottom: "1px solid var(--color-accent)",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--color-accent)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Selected from scatter ({pinnedRows.length}) — drag a new
                rectangle or click an empty area to clear
              </td>
            </tr>
          )}
          {([
            ...pinnedRows.map((r) => ({ row: r, pinned: true })),
            ...restRows.map((r) => ({ row: r, pinned: false })),
          ]).map(({ row, pinned }, seqIdx) => {
            const isSelected = openTickerSet.has(row.ticker);
            const isFirstUnpinned =
              pinnedRows.length > 0 && !pinned && seqIdx === pinnedRows.length;
            return (
              <tr
                key={row.ticker}
                onClick={() =>
                  isSelected ? onCloseTicker(row.ticker) : onOpenTicker(row.ticker)
                }
                onMouseEnter={() => setHoveredTicker(row.ticker)}
                style={{
                  height: ROW_HEIGHT,
                  cursor: "pointer",
                  background: pinned
                    ? "rgba(240,182,93,0.04)"
                    : isSelected
                      ? "rgba(240,182,93,0.06)"
                      : "transparent",
                  transition: "background 0.08s",
                  // Divider above the first non-pinned row when a selection
                  // is active — visually splits "selected from scatter" from
                  // the rest of the universe in their natural sort order.
                  borderTop: isFirstUnpinned
                    ? "2px solid var(--bg-border)"
                    : undefined,
                }}
              >
                <td
                  style={{
                    ...stickyLeftStyle,
                    left: 0,
                    width: TICKER_COL_WIDTH,
                    minWidth: TICKER_COL_WIDTH,
                    padding: "0 6px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: "var(--color-accent)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isSelected ? "rgba(240,182,93,0.06)" : "var(--bg-surface)",
                  }}
                >
                  {row.ticker}
                </td>
                <td
                  style={{
                    ...stickyLeftStyle,
                    left: TICKER_COL_WIDTH,
                    width: META_COL_WIDTH,
                    minWidth: META_COL_WIDTH,
                    padding: "3px 6px",
                    fontSize: BB_GRID_META_FONT_SIZE,
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isSelected ? "rgba(240,182,93,0.06)" : "var(--bg-surface)",
                  }}
                  title={`${row.sector} · ${row.subTheme}`}
                >
                  <div
                    style={{
                      color: "#d0d0d0",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.03em",
                      lineHeight: 1.15,
                      wordBreak: "break-word",
                    }}
                  >
                    {row.sector}
                  </div>
                  <div
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      letterSpacing: "0.005em",
                      lineHeight: 1.15,
                      wordBreak: "break-word",
                    }}
                  >
                    {row.subTheme}
                  </div>
                </td>
                {SUMMARY_KEYS.map((k, idx) => {
                  const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                  const cellRender =
                    cellRenders.get(row.ticker)?.get(k) ?? emptyCellRender();
                  const cohortKey =
                    screenerView.cohorts.keyByTicker.get(row.ticker) ?? "universe";
                  const widened = screenerView.cohorts.widenedFromTo.get(row.ticker);
                  const titleSuffix = ((): string => {
                    if ((k === "alpha" || k === "residual") && row.rollingObservationsPostBurn > 0) {
                      return `\nValid rolling-fit days summed: ${row.rollingObservationsPostBurn}`;
                    }
                    if (k === "alpha" || k === "residual") {
                      return `\nNo rolling fits available (sample too short for ${data.gridRollingWindow}d window).`;
                    }
                    return "";
                  })();
                  const cohortLine = screenerEnabled
                    ? `\nRanked vs ${describeCohortKey(cohortKey)}${
                        widened
                          ? ` (widened from ${describeCohortKey(widened.from)} — too few peers)`
                          : ""
                      }`
                    : "";
                  return (
                    <td
                      key={`summary-${k}`}
                      title={`${row.ticker} · ${summaryHeaderLabel(k, attributionMode)} = ${cellRender.text}${titleSuffix}${cohortLine}${
                        cellRender.tooltipExtra ? `\n${cellRender.tooltipExtra}` : ""
                      }`}
                      style={{
                        width: SUMMARY_COL_WIDTH,
                        minWidth: SUMMARY_COL_WIDTH,
                        padding: "0 6px",
                        background: isSelected
                          ? "rgba(240,182,93,0.06)"
                          : cellRender.bg,
                        textAlign: "center",
                        fontSize: BB_GRID_FONT_SIZE,
                        color: cellRender.color,
                        borderBottom: "1px solid rgba(0,0,0,0.6)",
                        borderRight: isLastSummary
                          ? "2px solid var(--bg-border)"
                          : "1px solid rgba(0,0,0,0.4)",
                      }}
                    >
                      {cellRender.text}
                    </td>
                  );
                })}
                {factors.map((code) => {
                  const cell = row.cells[code];
                  const cellRender =
                    cellRenders.get(row.ticker)?.get(code) ?? emptyCellRender();
                  const cohortKey =
                    screenerView.cohorts.keyByTicker.get(row.ticker) ?? "universe";
                  const widened = screenerView.cohorts.widenedFromTo.get(row.ticker);
                  const cohortLine = screenerEnabled
                    ? `\n\nRanked vs ${describeCohortKey(cohortKey)}${
                        widened
                          ? ` (widened from ${describeCohortKey(widened.from)} — too few peers)`
                          : ""
                      }`
                    : "";
                  const baseTitle = cell
                    ? `${getFactorDef(code).label}
β (static, full window) = ${cell.beta.toFixed(3)} (t=${cell.tStat.toFixed(1)})
Return contrib: ${(cell.returnContribution * 100).toFixed(2)}%   [β × Σ r_t, additive]
  · geometric variant (β × Π(1+r)−1): ${(cell.returnContributionGeometric * 100).toFixed(2)}%
Risk contrib: ${(cell.riskContribution * 100).toFixed(1)}%   [Euler, Σ aligned to regression sample]
${cell.riskContribution < 0 && cell.topCovariers && cell.topCovariers.length > 0
  ? `Negative PCR driven by covariance with: ${cell.topCovariers
      .slice(0, 3)
      .map((d) => `${getFactorDef(d.code).shortLabel} (${d.cov >= 0 ? "+" : ""}${(d.cov * 100).toFixed(2)})`)
      .join(", ")}`
  : "Click ticker for rolling β chart + predicted-vs-actual scatter"}`
                    : `${getFactorDef(code).label}: no data for this stock at this window`;
                  const titleExtra = cellRender.tooltipExtra
                    ? `\n${cellRender.tooltipExtra}`
                    : "";
                  return (
                    <td
                      key={code}
                      style={{
                        width: FACTOR_COL_WIDTH,
                        minWidth: FACTOR_COL_WIDTH,
                        padding: "0 6px",
                        background: isSelected
                          ? "rgba(240,182,93,0.06)"
                          : cellRender.bg,
                        textAlign: "center",
                        fontSize: BB_GRID_FONT_SIZE,
                        color: cellRender.color,
                        borderBottom: "1px solid rgba(0,0,0,0.6)",
                        borderRight: "1px solid rgba(0,0,0,0.4)",
                      }}
                      title={`${baseTitle}${titleExtra}${cohortLine}`}
                    >
                      {cellRender.text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {sortedRows.length === 0 && (
            <tr>
              <td
                colSpan={factors.length + 2 + SUMMARY_KEYS.length}
                style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}
              >
                {data.rows.length === 0
                  ? "No stocks match the current filters."
                  : `Every stock was filtered out — adjust filters to see rows. (${data.rows.length} hidden)`}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
