"use client";
/**
 * PortfolioFactorGrid — heatmap-style factor view scoped to the portfolio's
 * current holdings, mirroring the layout of `PerStockGrid` (the universe-wide
 * screener) so the user can read both with the same visual language.
 *
 * Rows:
 *   • One row per portfolio holding, sourced from the per-stock factor
 *     regression results (universe data is universe-wide; we filter to
 *     holdings client-side rather than re-running the regression).
 *   • A pinned "Total Portfolio" row at the bottom that aggregates
 *     β / return cells via signed-weighted sum, and pulls
 *     α / T / CI / Unexplained / Vol / R² / Risk from the portfolio-level
 *     OLS in `/api/analysis/factors/exposure` (which is the principled
 *     source — those statistics don't aggregate as linear sums).
 *
 * Sign convention: each holding's signedWeight = (isShort ? -1 : 1) × gross.
 * Beta cells in the Total row therefore correctly subtract a short's
 * exposure; return contributions invert sign for shorts as expected.
 */
import { useMemo, useState } from "react";
import {
  heatSequentialBloomberg,
  heatSignedBloomberg,
  heatTStatBloomberg,
} from "@/domain/calculations/heatmap";
import {
  useAnalysisStore,
  type FactorAttributionMode,
  type FactorGridMetric,
  type FactorGridStat,
  type FactorPeriod,
} from "@/store/analysis";
import type {
  PerStockResult,
  PerStockFactorCell,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type {
  AttributionResult,
  FactorCode,
  FactorExposureSnapshot,
} from "@/types/factors";
import type { PortfolioWeight } from "@/server/services/portfolio.service";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { getMetricDef } from "@/lib/factors/definitions/metric-defs";
import { pickPeriodSummary } from "@/lib/factors/attribution/pick-period-summary";
import { FactorTooltip } from "../shared/FactorTooltip";
import {
  BB_GRID_BORDER,
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  BB_GRID_HEADER_BG,
  BB_GRID_HEADER_COLOR,
  BB_GRID_HEADER_FONT_SIZE,
  BB_GRID_HEADER_FONT_WEIGHT,
  BB_GRID_HEADER_LETTER_SPACING,
  pickTextColor,
} from "../shared/bloomberg-grid";

interface PortfolioFactorGridProps {
  /** Universe-wide per-stock factor result (rows are filtered to holdings). */
  data: PerStockResult;
  /** Portfolio holdings with derived gross + signed weights. */
  holdings: PortfolioWeight[];
  /** Portfolio-level OLS snapshot (powers the Total row's α / T / CI / Vol / R² / Risk cells). */
  exposure: FactorExposureSnapshot | null;
  /** Portfolio attribution — drives the Total row's period Total Return cell. */
  attribution: AttributionResult | null | undefined;
  /** Active Attribution Period — selects which period's Total Return to show. */
  selectedPeriod: FactorPeriod;
  /** Beta / Return / Risk toggle, shared with PerStockView. */
  metric: FactorGridMetric;
  /**
   * STAT lens — same semantics as PerStockGrid. Risk × T/CI is blocked by
   * the toolbar and the store setters, so the impossible combination never
   * reaches us.
   */
  stat: FactorGridStat;
  /** Currently-open per-stock floating detail panels. */
  openTickers: ReadonlyArray<string>;
  onOpenTicker: (ticker: string) => void;
  onCloseTicker: (ticker: string) => void;
  onOpenPortfolioDetail: () => void;
}

type SummarySortKey =
  | "totalReturn"
  | "alpha"
  | "residual"
  | "realizedVol"
  | "rSquared";
type GridSortKey = "ticker" | "sector" | "weight" | SummarySortKey | FactorCode;

const TICKER_COL_WIDTH = 96;
const META_COL_WIDTH = 140;
const WEIGHT_COL_WIDTH = 78;
const SUMMARY_COL_WIDTH = 78;
const FACTOR_COL_WIDTH = 78;
const ROW_HEIGHT = 30;

// Total Return | R² | Vol | Alpha | Unexplained — realized period return
// first (price-based, geometric, stat-invariant), then descriptive stats
// (R² and Vol don't change with the Stat toggle), then the two stat-aware
// columns. Mirrors the per-stock screener grid's column order.
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

function pickValue(
  cell: PerStockFactorCell | undefined,
  metric: FactorGridMetric,
  mode: FactorAttributionMode,
): number | null {
  if (!cell) return null;
  if (metric === "beta") return cell.beta;
  if (metric === "return") {
    // Log mode shows the static log-OLS factor contribution so the grid
    // factor column ties to the per-stock waterfall's log-space bar.
    if (mode === "log") return cell.returnContributionLog ?? cell.returnContribution;
    return cell.returnContribution;
  }
  return cell.riskContribution;
}

function formatValue(v: number | null, metric: FactorGridMetric): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (metric === "beta") return v.toFixed(2);
  if (metric === "return") return `${(v * 100).toFixed(1)}%`;
  return `${(v * 100).toFixed(1)}%`;
}

function formatCellValue(
  v: number | null,
  metric: FactorGridMetric,
  stat: FactorGridStat,
): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (stat === "t") return v.toFixed(2);
  if (stat === "ci") {
    if (metric === "beta") return `±${v.toFixed(2)}`;
    return `±${(v * 100).toFixed(1)}%`;
  }
  return formatValue(v, metric);
}

function ciHalfFromValueAndT(value: number, tStat: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(tStat)) return null;
  if (Math.abs(tStat) < 1e-9) return null;
  return Math.abs(value / tStat) * 1.96;
}

/**
 * Stat-aware, mode-aware lookup for per-holding rows (mirrors PerStockGrid).
 *
 * Alpha / Unexplained VALUE now read the static-horizon-beta period sums
 * (`rollingAlphaPostBurnSum*` / `rollingResidualPostBurnSum*` are overwritten
 * by the route's period overlay with the static-beta slice values), routed to
 * the log fields when attribution mode = "log" (the default) so the grid ties
 * to the per-stock waterfall. T / CI stay on the static snapshot-OLS stats.
 */
function summaryValue(
  row: PerStockRow,
  key: SummarySortKey,
  stat: FactorGridStat,
  mode: FactorAttributionMode,
): number | null {
  // Total Return is stat-invariant — the realized period total stock return
  // (price-based, geometric, dividend-inclusive), already overlaid to the
  // active Attribution Period by the per-stock route.
  if (key === "totalReturn") return row.realizedTotalReturn;
  if (key === "rSquared") return row.rSquared;
  if (key === "realizedVol") return row.realizedAnnualizedVol;
  const useLog = mode === "log";
  if (key === "alpha") {
    if (stat === "t") return useLog ? row.alphaTStatLog : row.alphaTStat;
    if (stat === "ci") return row.alphaCi95Half > 0 ? row.alphaCi95Half : null;
    return useLog ? row.rollingAlphaPostBurnSumLog : row.rollingAlphaPostBurnSum;
  }
  // residual
  if (stat === "t") return useLog ? row.residualTStatLog : row.residualTStat;
  if (stat === "ci")
    return row.residualCi95Half != null && row.residualCi95Half > 0 ? row.residualCi95Half : null;
  return useLog ? row.rollingResidualPostBurnSumLog : row.rollingResidualPostBurnSum;
}

function formatSummaryValue(v: number | null, key: SummarySortKey, stat: FactorGridStat): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (key === "rSquared") return `${(v * 100).toFixed(0)}%`;
  if (key === "realizedVol") return `${(v * 100).toFixed(1)}%`;
  if (key === "totalReturn") {
    const sign = v >= 0 ? "+" : "";
    return `${sign}${(v * 100).toFixed(1)}%`;
  }
  if (stat === "t") return v.toFixed(2);
  if (stat === "ci") return `±${(v * 100).toFixed(1)}%`;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

/** Pull what a per-holding factor cell currently shows under (metric, stat). */
function factorCellShownValue(
  cell: PerStockFactorCell | undefined,
  metric: FactorGridMetric,
  stat: FactorGridStat,
  mode: FactorAttributionMode,
): number | null {
  if (!cell) return null;
  if (stat === "t") return cell.tStat;
  if (stat === "ci") {
    if (metric === "risk") return null;
    const base = pickValue(cell, metric, mode);
    if (base === null) return null;
    return ciHalfFromValueAndT(base, cell.tStat);
  }
  return pickValue(cell, metric, mode);
}

const headerCellStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: BB_GRID_HEADER_BG,
  color: BB_GRID_HEADER_COLOR,
  fontSize: BB_GRID_HEADER_FONT_SIZE,
  fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
  letterSpacing: BB_GRID_HEADER_LETTER_SPACING,
  textTransform: "uppercase",
  padding: "2px 6px",
  borderRight: BB_GRID_BORDER,
  borderBottom: BB_GRID_BORDER,
  textAlign: "center",
  whiteSpace: "nowrap",
  zIndex: 2,
};

const stickyLeftStyle: React.CSSProperties = {
  position: "sticky",
  left: 0,
  background: "var(--bg-surface)",
  borderRight: BB_GRID_BORDER,
  zIndex: 1,
};

interface TotalRowSummary {
  rSquared: number | null;
  realizedVol: number | null;
  alpha: number | null;
  residual: number | null;
}

/**
 * Total Portfolio row.
 *
 * Factor cells:
 *   • metric=β / return: signed-weighted sum of per-stock cells (linear).
 *   • metric=risk: pulled from portfolio-level OLS in /exposure (PCR is
 *     non-linear in β; weighted sums of per-stock PCRs would be wrong).
 *
 * Summary cells:
 *   • R², Vol, Alpha-Value: portfolio-level OLS via /exposure (rSquared,
 *     realizedAnnualizedVol, alphaAnnualized).
 *   • Unexplained (Value/T/CI): constructed-from-per-stock residual stats
 *     surfaced by the portfolio-residual service (`exposure.residual.*`).
 *     Genuinely a roll-up of the grid.
 *
 * Stat lens mapping for the Total row:
 *   • alpha cell: Value→alphaAnnualized; T→alphaTStat; CI→1.96·|α/T_α|.
 *   • residual cell: Value→residual.sum; T→residual.tStat; CI→residual.ci95Half.
 *   • factor cells: Value→weighted-sum (β/RC) or PCR (risk); T→portfolio-OLS
 *     factor t-stat (the principled aggregate, since per-stock t-stats don't
 *     aggregate); CI→1.96·|value/T| using portfolio's t.
 */
interface TotalRow {
  /** value-mode amount per factor (β/RC/PCR) — used for STAT=value AND as
   *  the magnitude in CI mode (CI = 1.96·|value/t|). */
  cellValue: Partial<Record<FactorCode, number | null>>;
  /** portfolio-level t-stat per factor from /exposure. */
  cellTStat: Partial<Record<FactorCode, number | null>>;
  summary: TotalRowSummary;
}

function buildTotalRow(
  filteredRows: PerStockRow[],
  weightByTicker: Map<string, number>,
  factors: FactorCode[],
  metric: FactorGridMetric,
  mode: FactorAttributionMode,
  exposure: FactorExposureSnapshot | null,
): TotalRow {
  const cellValue: TotalRow["cellValue"] = {};
  const cellTStat: TotalRow["cellTStat"] = {};
  const exposureFactorMap = new Map(
    (exposure?.factors ?? []).map((f) => [f.code, f]),
  );
  for (const code of factors) {
    // value-mode amount.
    if (metric === "risk") {
      cellValue[code] = exposureFactorMap.get(code)?.pctRiskContrib ?? null;
    } else {
      let total = 0;
      let any = false;
      for (const row of filteredRows) {
        const w = weightByTicker.get(row.ticker) ?? 0;
        const v = pickValue(row.cells[code], metric, mode);
        if (v === null || !Number.isFinite(v)) continue;
        total += w * v;
        any = true;
      }
      cellValue[code] = any ? total : null;
    }
    // t-stat from portfolio's own OLS — the principled aggregate.
    cellTStat[code] = exposureFactorMap.get(code)?.tStat ?? null;
  }

  // Total-row defaults read the simple-space fields; the rendering path
  // calls totalSummaryValue(key, stat, exposure, mode) at draw time, which
  // is where mode-routing happens. These defaults are only used as the
  // fallback when totalSummaryValue isn't queried explicitly.
  const summary: TotalRowSummary = {
    rSquared: exposure?.rSquared ?? null,
    realizedVol: exposure?.realizedAnnualizedVol ?? null,
    alpha: exposure?.alphaAnnualized ?? null,
    residual: exposure?.residual?.sum ?? null,
  };

  return { cellValue, cellTStat, summary };
}

/**
 * Stat-aware reader for the Total row's summary column. Pulls from the
 * portfolio exposure snapshot under T / CI lens, and routes between log /
 * simple space using the active attribution mode (default: log).
 *
 * When mode = "log" but the log-space residual or static-α failed (rare
 * fallback path — usually a daily portfolio simple return below −100 %),
 * we silently fall back to simple-space rather than rendering "—" so the
 * Total row stays informative.
 */
function totalSummaryValue(
  key: SummarySortKey,
  stat: FactorGridStat,
  exposure: FactorExposureSnapshot | null,
  mode: "log" | "simple" = "log",
): number | null {
  // Total Return for the Total row is the portfolio's realized period total
  // return, resolved from attribution by the caller (not derivable from the
  // exposure snapshot) — handled in the render path, not here.
  if (key === "totalReturn") return null;
  if (!exposure) return null;
  if (key === "rSquared") return exposure.rSquared ?? null;
  if (key === "realizedVol") return exposure.realizedAnnualizedVol ?? null;
  if (key === "alpha") {
    const useLog = mode === "log" && exposure.alphaAnnualizedLog != null;
    const ann = useLog ? exposure.alphaAnnualizedLog : exposure.alphaAnnualized;
    const tStat = useLog ? exposure.alphaTStatLog : exposure.alphaTStat;
    const ciHalf = useLog ? exposure.alphaCi95HalfLog : null;
    if (stat === "t") return tStat ?? null;
    if (stat === "ci") {
      if (useLog && ciHalf != null) return ciHalf;
      // Simple-space fallback: derive 1.96 × SE(α) annualised = 1.96 × |α/T_α|.
      if (tStat && Math.abs(tStat) > 1e-9 && ann != null) {
        return Math.abs(ann / tStat) * 1.96;
      }
      return null;
    }
    return ann ?? null;
  }
  // residual
  const r = exposure.residual;
  if (!r) return null;
  const useLog =
    mode === "log" && r.sumLog != null && Number.isFinite(r.sumLog);
  if (stat === "t") {
    return useLog ? r.tStatLog ?? null : r.tStat;
  }
  if (stat === "ci") {
    if (useLog) {
      const v = r.ci95HalfLog;
      return v != null && v > 0 ? v : null;
    }
    return r.ci95Half > 0 ? r.ci95Half : null;
  }
  return useLog ? r.sumLog ?? null : r.sum;
}

/** Total row's factor cell value under the active (metric, stat) lens. */
function totalFactorCellValue(
  code: FactorCode,
  totalRow: TotalRow,
  metric: FactorGridMetric,
  stat: FactorGridStat,
): number | null {
  const valueMode = totalRow.cellValue[code] ?? null;
  if (stat === "value") return valueMode;
  const t = totalRow.cellTStat[code] ?? null;
  if (stat === "t") return t;
  // ci
  if (metric === "risk") return null;
  if (valueMode === null || t === null) return null;
  return ciHalfFromValueAndT(valueMode, t);
}

function compareRows(
  a: PerStockRow,
  b: PerStockRow,
  weightByTicker: Map<string, number>,
  key: GridSortKey,
  metric: FactorGridMetric,
  stat: FactorGridStat,
  mode: FactorAttributionMode,
  dir: "asc" | "desc",
): number {
  if (key === "ticker") {
    const c = a.ticker.localeCompare(b.ticker);
    return dir === "desc" ? -c : c;
  }
  if (key === "sector") {
    const sa = `${a.sector}\0${a.subTheme}`;
    const sb = `${b.sector}\0${b.subTheme}`;
    const c = sa.localeCompare(sb);
    return dir === "desc" ? -c : c;
  }
  if (key === "weight") {
    const va = weightByTicker.get(a.ticker) ?? 0;
    const vb = weightByTicker.get(b.ticker) ?? 0;
    const diff = vb - va;
    if (diff !== 0) return dir === "desc" ? diff : -diff;
    return a.ticker.localeCompare(b.ticker);
  }
  const isSummary = (SUMMARY_KEYS as readonly string[]).includes(key as string);
  const va = isSummary
    ? summaryValue(a, key as SummarySortKey, stat, mode)
    : factorCellShownValue(a.cells[key as FactorCode], metric, stat, mode);
  const vb = isSummary
    ? summaryValue(b, key as SummarySortKey, stat, mode)
    : factorCellShownValue(b.cells[key as FactorCode], metric, stat, mode);
  const na = va === null || !Number.isFinite(va);
  const nb = vb === null || !Number.isFinite(vb);
  if (na && nb) return a.ticker.localeCompare(b.ticker);
  if (na) return 1;
  if (nb) return -1;
  const diff = (vb as number) - (va as number);
  if (diff !== 0) return dir === "desc" ? diff : -diff;
  return a.ticker.localeCompare(b.ticker);
}

function SortCaret({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return (
    <span style={{ color: "var(--color-accent)", marginLeft: 4, fontSize: 9 }}>
      {dir === "desc" ? "▼" : "▲"}
    </span>
  );
}

export function PortfolioFactorGrid({
  data,
  holdings,
  exposure,
  attribution,
  selectedPeriod,
  metric,
  stat,
  openTickers,
  onOpenTicker,
  onCloseTicker,
  onOpenPortfolioDetail,
}: PortfolioFactorGridProps) {
  const openTickerSet = useMemo(() => new Set(openTickers), [openTickers]);
  const factors = data.usableFactors;
  // Attribution mode for the Total row's Alpha + Unexplained. Default log;
  // matches the per-stock grid so both views agree on which space the
  // user is reading.
  const attributionMode = useAnalysisStore((s) => s.factorAttributionMode);

  // Portfolio realized total return over the selected Attribution Period —
  // mode-aware (log geometric / simple arithmetic). Drives the Total row's
  // Total Return cell so it ties to the Total Return Decomposition headline.
  const portfolioPeriodTotalReturn = useMemo(() => {
    const picked = pickPeriodSummary(attribution, selectedPeriod, attributionMode);
    return picked?.totalReturn ?? null;
  }, [attribution, selectedPeriod, attributionMode]);

  // Map ticker → signed weight; tickers in holdings but not in the per-stock
  // result will simply not appear as rows (the regression didn't fit them).
  const signedWeightByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings) m.set(h.ticker.toUpperCase(), h.signedWeight);
    return m;
  }, [holdings]);
  const grossWeightByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of holdings) m.set(h.ticker.toUpperCase(), h.grossWeight);
    return m;
  }, [holdings]);
  const isShortByTicker = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const h of holdings) m.set(h.ticker.toUpperCase(), h.isShort);
    return m;
  }, [holdings]);

  const filteredRows = useMemo(
    () => data.rows.filter((r) => signedWeightByTicker.has(r.ticker.toUpperCase())),
    [data.rows, signedWeightByTicker],
  );

  const [sortBy, setSortBy] = useState<{ key: GridSortKey; dir: "asc" | "desc" } | null>({
    key: "weight",
    dir: "desc",
  });

  const onHeaderClick = (key: GridSortKey) => {
    setSortBy((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  const sortedRows = useMemo(() => {
    const rows = [...filteredRows];
    if (!sortBy) return rows;
    rows.sort((a, b) =>
      compareRows(a, b, signedWeightByTicker, sortBy.key, metric, stat, attributionMode, sortBy.dir),
    );
    return rows;
  }, [filteredRows, sortBy, metric, stat, attributionMode, signedWeightByTicker]);

  const totalRow = useMemo(
    () => buildTotalRow(filteredRows, signedWeightByTicker, factors, metric, attributionMode, exposure),
    [filteredRows, signedWeightByTicker, factors, metric, attributionMode, exposure],
  );

  // Heatmap span — anchor on max |value-mode magnitude| across stock rows
  // AND the total row so the shading is stable when the user toggles STAT.
  const colSpans = useMemo(() => {
    const m = new Map<FactorCode, number>();
    for (const f of factors) {
      let max = 0;
      for (const r of filteredRows) {
        const v = pickValue(r.cells[f], metric, attributionMode);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      const tot = totalRow.cellValue[f];
      if (tot !== null && tot !== undefined && Number.isFinite(tot) && Math.abs(tot) > max) {
        max = Math.abs(tot);
      }
      m.set(f, Math.max(max, 1e-6));
    }
    return m;
  }, [factors, filteredRows, metric, attributionMode, totalRow]);

  const summarySpans = useMemo(() => {
    const out: Record<SummarySortKey, number> = {
      totalReturn: 1e-6,
      rSquared: 1e-6,
      realizedVol: 1e-6,
      alpha: 1e-6,
      residual: 1e-6,
    };
    for (const k of SUMMARY_KEYS) {
      let max = 0;
      // Always read in value mode so the heat scale is stable across STAT toggle.
      for (const r of filteredRows) {
        const v = summaryValue(r, k, "value", attributionMode);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      out[k] = Math.max(max, 1e-6);
    }
    return out;
  }, [filteredRows, attributionMode]);

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

  const showEmpty = filteredRows.length === 0;

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
          minWidth: "100%",
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
            >
              <button
                type="button"
                onClick={() => onHeaderClick("ticker")}
                style={{ ...headerButtonBase, justifyContent: "flex-start", paddingLeft: 10 }}
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
            >
              <button
                type="button"
                onClick={() => onHeaderClick("sector")}
                style={{ ...headerButtonBase, justifyContent: "flex-start", paddingLeft: 10 }}
                title="Sort by sector / sub-theme"
              >
                Sector / Sub-theme
                <SortCaret active={sortBy?.key === "sector"} dir={sortBy?.dir ?? "desc"} />
              </button>
            </th>
            {/* Weight column (signed: + for long, − for short). */}
            <th
              style={{
                ...headerCellStyle,
                width: WEIGHT_COL_WIDTH,
                minWidth: WEIGHT_COL_WIDTH,
                padding: 0,
                borderRight: "2px solid var(--bg-border)",
              }}
              title="Signed portfolio weight (positive = long, negative = short). Derived from shares × latest price."
            >
              <button
                type="button"
                onClick={() => onHeaderClick("weight")}
                style={headerButtonBase}
              >
                Weight
                <SortCaret active={sortBy?.key === "weight"} dir={sortBy?.dir ?? "desc"} />
              </button>
            </th>
            {SUMMARY_KEYS.map((k, idx) => {
              const isLastSummary = idx === SUMMARY_KEYS.length - 1;
              const md = getMetricDef(k);
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
                >
                  <button
                    type="button"
                    onClick={() => onHeaderClick(k)}
                    style={headerButtonBase}
                  >
                    <FactorTooltip
                      name={md.name}
                      definition={md.definition}
                      howCalculated={md.howCalculated}
                      dataUsed={md.dataUsed}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {SUMMARY_LABELS[k]}
                      </span>
                    </FactorTooltip>
                    <SortCaret active={sortBy?.key === k} dir={sortBy?.dir ?? "desc"} />
                  </button>
                </th>
              );
            })}
            {factors.map((code) => {
              const def = getFactorDef(code);
              return (
                <th
                  key={code}
                  style={{
                    ...headerCellStyle,
                    width: FACTOR_COL_WIDTH,
                    minWidth: FACTOR_COL_WIDTH,
                    padding: 0,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onHeaderClick(code)}
                    title="Click to sort rows by this column"
                    style={headerButtonBase}
                  >
                    <FactorTooltip code={code} concise>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{def.shortLabel}</span>
                    </FactorTooltip>
                    <SortCaret active={sortBy?.key === code} dir={sortBy?.dir ?? "desc"} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isSelected = openTickerSet.has(row.ticker);
            const tickerKey = row.ticker.toUpperCase();
            const signed = signedWeightByTicker.get(tickerKey) ?? 0;
            const gross = grossWeightByTicker.get(tickerKey) ?? 0;
            const isShort = isShortByTicker.get(tickerKey) ?? false;
            return (
              <tr
                key={row.ticker}
                onClick={() =>
                  isSelected ? onCloseTicker(row.ticker) : onOpenTicker(row.ticker)
                }
                style={{
                  height: ROW_HEIGHT,
                  cursor: "pointer",
                  background: isSelected ? "rgba(240,182,93,0.06)" : "transparent",
                  transition: "background 0.08s",
                }}
              >
                <td
                  style={{
                    ...stickyLeftStyle,
                    left: 0,
                    width: TICKER_COL_WIDTH,
                    minWidth: TICKER_COL_WIDTH,
                    padding: "0 10px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: "var(--color-accent)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isSelected ? "rgba(240,182,93,0.06)" : "var(--bg-surface)",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {row.ticker}
                    {isShort && (
                      <span
                        title="Short position"
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          padding: "1px 4px",
                          borderRadius: 2,
                          background: "rgba(239,68,68,0.18)",
                          color: "var(--color-negative, #ef4444)",
                        }}
                      >
                        S
                      </span>
                    )}
                  </span>
                </td>
                <td
                  style={{
                    ...stickyLeftStyle,
                    left: TICKER_COL_WIDTH,
                    width: META_COL_WIDTH,
                    minWidth: META_COL_WIDTH,
                    padding: "0 10px",
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: isSelected ? "rgba(240,182,93,0.06)" : "var(--bg-surface)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`${row.sector} · ${row.subTheme}`}
                >
                  <div
                    style={{
                      color: "#d0d0d0",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.sector}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      letterSpacing: "0.005em",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.subTheme}
                  </div>
                </td>
                <td
                  style={{
                    width: WEIGHT_COL_WIDTH,
                    minWidth: WEIGHT_COL_WIDTH,
                    padding: "0 8px",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    color: signed < 0 ? "var(--color-negative, #ef4444)" : "var(--text-primary)",
                    background: isSelected ? "rgba(240,182,93,0.06)" : "var(--bg-surface)",
                    borderBottom: "1px solid rgba(0,0,0,0.6)",
                    borderRight: "2px solid var(--bg-border)",
                  }}
                  title={`Gross ${(gross * 100).toFixed(2)}%, signed ${(signed * 100).toFixed(2)}%`}
                >
                  {`${signed >= 0 ? "+" : ""}${(signed * 100).toFixed(1)}%`}
                </td>
                {SUMMARY_KEYS.map((k, idx) => {
                  const v = summaryValue(row, k, stat, attributionMode);
                  const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                  const bg = ((): string => {
                    if (v === null || !Number.isFinite(v)) return "rgba(255,255,255,0.02)";
                    if (k === "totalReturn")
                      return heatSignedBloomberg(v, summarySpans.totalReturn);
                    if (k === "rSquared") return heatSequentialBloomberg(v, 1, "green");
                    if (k === "realizedVol")
                      return heatSequentialBloomberg(v, summarySpans.realizedVol, "red");
                    // alpha + residual respond to stat — under T or CI the
                    // heat is keyed on |t| (CI heat = identical to T heat
                    // because |T| = |value|/(CI/1.96)).
                    if (stat === "t") return heatTStatBloomberg(v);
                    if (stat === "ci") {
                      const tForRow =
                        k === "alpha"
                          ? row.alphaTStat
                          : row.residualTStat ?? Number.NaN;
                      return Number.isFinite(tForRow)
                        ? heatTStatBloomberg(tForRow)
                        : "rgba(255,255,255,0.02)";
                    }
                    return heatSignedBloomberg(v, summarySpans[k]);
                  })();
                  const lowFit = k === "rSquared" && v !== null && Number.isFinite(v) && v < 0.3;
                  const color =
                    v === null || !Number.isFinite(v)
                      ? "var(--text-muted)"
                      : lowFit
                        ? "var(--text-muted)"
                        : pickTextColor(bg);
                  return (
                    <td
                      key={`summary-${k}`}
                      style={{
                        width: SUMMARY_COL_WIDTH,
                        minWidth: SUMMARY_COL_WIDTH,
                        padding: "0 6px",
                        background: isSelected ? "rgba(240,182,93,0.06)" : bg,
                        textAlign: "center",
                        fontSize: BB_GRID_FONT_SIZE,
                        color,
                        borderBottom: "1px solid rgba(0,0,0,0.6)",
                        borderRight: isLastSummary
                          ? "2px solid var(--bg-border)"
                          : "1px solid rgba(0,0,0,0.4)",
                      }}
                    >
                      {formatSummaryValue(v, k, stat)}
                    </td>
                  );
                })}
                {factors.map((code) => {
                  const cell = row.cells[code];
                  const value = factorCellShownValue(cell, metric, stat, attributionMode);
                  const span = colSpans.get(code) ?? 1;
                  const bg = ((): string => {
                    if (value === null || !Number.isFinite(value))
                      return "rgba(255,255,255,0.02)";
                    if (stat === "t" || stat === "ci") {
                      return heatTStatBloomberg(cell?.tStat ?? Number.NaN);
                    }
                    return heatSignedBloomberg(value, span);
                  })();
                  return (
                    <td
                      key={code}
                      style={{
                        width: FACTOR_COL_WIDTH,
                        minWidth: FACTOR_COL_WIDTH,
                        padding: "0 6px",
                        background: isSelected ? "rgba(240,182,93,0.06)" : bg,
                        textAlign: "center",
                        fontSize: BB_GRID_FONT_SIZE,
                        color: value !== null ? pickTextColor(bg) : "var(--text-muted)",
                        borderBottom: "1px solid rgba(0,0,0,0.6)",
                        borderRight: "1px solid rgba(0,0,0,0.4)",
                      }}
                      title={
                        cell
                          ? `${getFactorDef(code).label}\nβ = ${cell.beta.toFixed(3)} (t=${cell.tStat.toFixed(1)})`
                          : `${getFactorDef(code).label}: no data for this stock at this window`
                      }
                    >
                      {formatCellValue(value, metric, stat)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {showEmpty && (
            <tr>
              <td
                colSpan={factors.length + 3 + SUMMARY_KEYS.length}
                style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}
              >
                Portfolio is empty, or none of its tickers are in the factor universe.
              </td>
            </tr>
          )}
          {!showEmpty && (
            <tr
              onClick={onOpenPortfolioDetail}
              style={{
                height: ROW_HEIGHT + 4,
                cursor: "pointer",
                background: "rgba(240,182,93,0.10)",
                borderTop: "2px solid var(--color-accent)",
              }}
              title="Click to open portfolio-level factor detail"
            >
              <td
                style={{
                  ...stickyLeftStyle,
                  left: 0,
                  width: TICKER_COL_WIDTH,
                  minWidth: TICKER_COL_WIDTH,
                  padding: "0 10px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--color-accent)",
                  background: "rgba(240,182,93,0.10)",
                  borderTop: "2px solid var(--color-accent)",
                }}
              >
                TOTAL
              </td>
              <td
                style={{
                  ...stickyLeftStyle,
                  left: TICKER_COL_WIDTH,
                  width: META_COL_WIDTH,
                  minWidth: META_COL_WIDTH,
                  padding: "0 10px",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  background: "rgba(240,182,93,0.10)",
                  borderTop: "2px solid var(--color-accent)",
                }}
              >
                Portfolio (signed-weighted)
              </td>
              <td
                style={{
                  width: WEIGHT_COL_WIDTH,
                  minWidth: WEIGHT_COL_WIDTH,
                  padding: "0 8px",
                  textAlign: "right",
                  background: "rgba(240,182,93,0.10)",
                  borderTop: "2px solid var(--color-accent)",
                  borderRight: "2px solid var(--bg-border)",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                }}
                title="Net exposure: Σ signed_weight (longs − shorts)"
              >
                {(() => {
                  const net = filteredRows.reduce(
                    (s, r) => s + (signedWeightByTicker.get(r.ticker.toUpperCase()) ?? 0),
                    0,
                  );
                  return `${net >= 0 ? "+" : ""}${(net * 100).toFixed(1)}%`;
                })()}
              </td>
              {SUMMARY_KEYS.map((k, idx) => {
                const v =
                  k === "totalReturn"
                    ? portfolioPeriodTotalReturn
                    : totalSummaryValue(k, stat, exposure, attributionMode);
                const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                const bg = ((): string => {
                  if (v === null || !Number.isFinite(v)) return "rgba(240,182,93,0.10)";
                  if (k === "totalReturn")
                    return heatSignedBloomberg(v, summarySpans.totalReturn);
                  if (k === "rSquared") return heatSequentialBloomberg(v, 1, "green");
                  if (k === "realizedVol")
                    return heatSequentialBloomberg(v, summarySpans.realizedVol, "red");
                  // alpha + residual: same |t|-keyed heat as the per-holding rows.
                  // Use the mode-correct t-stat so heat lines up with the value.
                  if (stat === "t") return heatTStatBloomberg(v);
                  if (stat === "ci") {
                    const tForCol =
                      k === "alpha"
                        ? (attributionMode === "log"
                            ? exposure?.alphaTStatLog
                            : exposure?.alphaTStat) ?? Number.NaN
                        : (attributionMode === "log"
                            ? exposure?.residual?.tStatLog
                            : exposure?.residual?.tStat) ?? Number.NaN;
                    return Number.isFinite(tForCol)
                      ? heatTStatBloomberg(tForCol)
                      : "rgba(240,182,93,0.10)";
                  }
                  return heatSignedBloomberg(v, summarySpans[k]);
                })();
                return (
                  <td
                    key={`total-summary-${k}`}
                    style={{
                      width: SUMMARY_COL_WIDTH,
                      minWidth: SUMMARY_COL_WIDTH,
                      padding: "0 6px",
                      background: bg,
                      textAlign: "center",
                      fontSize: BB_GRID_FONT_SIZE,
                      fontWeight: 700,
                      color: v === null ? "var(--text-muted)" : pickTextColor(bg),
                      borderTop: "2px solid var(--color-accent)",
                      borderRight: isLastSummary
                        ? "2px solid var(--bg-border)"
                        : "1px solid rgba(0,0,0,0.4)",
                    }}
                    title={k === "residual" && exposure?.residual
                      ? `Constructed-from-per-stock residual ε_p,t = Σ wᵢ·εᵢ,t.\nNewey-West (1994) HAC SE on mean(ε_p,t), bandwidth L = ${exposure.residual.bandwidth}.\nSeries ${exposure.residual.startDate} → ${exposure.residual.endDate}, n = ${exposure.residual.n} obs.${exposure.residual.droppedHoldings.length > 0 ? `\nDropped holdings (no usable rolling fit): ${exposure.residual.droppedHoldings.join(", ")}.` : ""}`
                      : undefined}
                  >
                    {formatSummaryValue(v, k, stat)}
                  </td>
                );
              })}
              {factors.map((code) => {
                const value = totalFactorCellValue(code, totalRow, metric, stat);
                const span = colSpans.get(code) ?? 1;
                const bg = ((): string => {
                  if (value === null || !Number.isFinite(value))
                    return "rgba(240,182,93,0.10)";
                  if (stat === "t" || stat === "ci") {
                    const t = totalRow.cellTStat[code] ?? Number.NaN;
                    return Number.isFinite(t)
                      ? heatTStatBloomberg(t)
                      : "rgba(240,182,93,0.10)";
                  }
                  return heatSignedBloomberg(value, span);
                })();
                return (
                  <td
                    key={`total-${code}`}
                    style={{
                      width: FACTOR_COL_WIDTH,
                      minWidth: FACTOR_COL_WIDTH,
                      padding: "0 6px",
                      background: bg,
                      textAlign: "center",
                      fontSize: BB_GRID_FONT_SIZE,
                      fontWeight: 700,
                      color: value !== null ? pickTextColor(bg) : "var(--text-muted)",
                      borderTop: "2px solid var(--color-accent)",
                      borderRight: "1px solid rgba(0,0,0,0.4)",
                    }}
                    title={
                      stat === "t"
                        ? `${getFactorDef(code).label}: portfolio-level OLS t-stat from /exposure.`
                        : stat === "ci"
                          ? `${getFactorDef(code).label}: 1.96 × |value/T| using portfolio's own t-stat.`
                          : metric === "risk"
                            ? `${getFactorDef(code).label}: portfolio-level risk contribution from /exposure (true OLS, not weighted sum).`
                            : `${getFactorDef(code).label}: Σ wᵢ × per-stock value (linear under OLS — exact).`
                    }
                  >
                    {formatCellValue(value, metric, stat)}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
