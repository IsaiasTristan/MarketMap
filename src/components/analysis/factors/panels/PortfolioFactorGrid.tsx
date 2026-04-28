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
import type { FactorGridMetric } from "@/store/analysis";
import type {
  PerStockResult,
  PerStockFactorCell,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type { FactorCode, FactorExposureSnapshot } from "@/types/factors";
import type { PortfolioWeight } from "@/server/services/portfolio.service";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
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
  /** Beta / Return / Risk toggle, shared with PerStockView. */
  metric: FactorGridMetric;
  /** Currently-open per-stock floating detail panels. */
  openTickers: ReadonlyArray<string>;
  onOpenTicker: (ticker: string) => void;
  onCloseTicker: (ticker: string) => void;
  onOpenPortfolioDetail: () => void;
}

type SummarySortKey =
  | "alpha"
  | "alphaT"
  | "alphaCi"
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

const SUMMARY_KEYS: readonly SummarySortKey[] = [
  "alpha",
  "alphaT",
  "alphaCi",
  "residual",
  "realizedVol",
  "rSquared",
] as const;

const SUMMARY_LABELS: Record<SummarySortKey, string> = {
  alpha: "Alpha",
  alphaT: "T",
  alphaCi: "CI",
  residual: "Unexplained",
  realizedVol: "Vol",
  rSquared: "R²",
};

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

function summaryValue(row: PerStockRow, key: SummarySortKey): number | null {
  if (key === "alpha") return row.rollingAlphaPostBurnSum;
  if (key === "alphaT") return row.alphaTStat;
  if (key === "alphaCi") return row.alphaCi95Half;
  if (key === "residual") return row.rollingResidualPostBurnSum;
  if (key === "realizedVol") return row.realizedAnnualizedVol;
  return row.rSquared;
}

function formatSummaryValue(v: number | null, key: SummarySortKey): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (key === "alphaT") return v.toFixed(2);
  if (key === "alphaCi") return v > 0 ? `±${(v * 100).toFixed(1)}%` : "—";
  if (key === "rSquared") return `${(v * 100).toFixed(0)}%`;
  if (key === "realizedVol") return `${(v * 100).toFixed(1)}%`;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
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
  alpha: number | null;
  alphaT: number | null;
  alphaCi: number | null;
  residual: number | null;
  realizedVol: number | null;
  rSquared: number | null;
}

/**
 * Total Portfolio row — β / return cells aggregate per-stock results via
 * signed weights (linear, exact under the same OLS); risk + α + T + CI +
 * Vol + R² come from the portfolio-level regression in /exposure (which
 * is the principled source for those non-linear stats).
 */
interface TotalRow {
  cells: Partial<Record<FactorCode, { value: number | null; metric: FactorGridMetric }>>;
  summary: TotalRowSummary;
}

function buildTotalRow(
  filteredRows: PerStockRow[],
  weightByTicker: Map<string, number>,
  factors: FactorCode[],
  metric: FactorGridMetric,
  exposure: FactorExposureSnapshot | null,
): TotalRow {
  const cells: TotalRow["cells"] = {};
  for (const code of factors) {
    if (metric === "risk") {
      // Risk contribution: pull from the portfolio-level regression. The
      // weighted sum of per-stock PCRs is mathematically wrong because PCR
      // depends on covariance between names — not a linear aggregate.
      const f = exposure?.factors.find((x) => x.code === code);
      cells[code] = { value: f?.pctRiskContrib ?? null, metric };
      continue;
    }
    // β and return contribution are linear in weights — exact weighted sum.
    let total = 0;
    let any = false;
    for (const row of filteredRows) {
      const w = weightByTicker.get(row.ticker) ?? 0;
      const v = pickValue(row.cells[code], metric);
      if (v === null || !Number.isFinite(v)) continue;
      total += w * v;
      any = true;
    }
    cells[code] = { value: any ? total : null, metric };
  }

  const summary: TotalRowSummary = {
    alpha: exposure?.alphaAnnualized ?? null,
    alphaT: exposure?.alphaTStat ?? null,
    // Snapshot doesn't yet expose alpha CI half-width — leave as null.
    alphaCi: null,
    // Σε for the portfolio is approximately 0 by construction (the OLS
    // intercept absorbs the mean residual). Leave as null rather than
    // showing a misleading near-zero number.
    residual: null,
    realizedVol: exposure?.realizedAnnualizedVol ?? null,
    rSquared: exposure?.rSquared ?? null,
  };

  return { cells, summary };
}

function compareRows(
  a: PerStockRow,
  b: PerStockRow,
  weightByTicker: Map<string, number>,
  key: GridSortKey,
  metric: FactorGridMetric,
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
    ? summaryValue(a, key as SummarySortKey)
    : pickValue(a.cells[key as FactorCode], metric);
  const vb = isSummary
    ? summaryValue(b, key as SummarySortKey)
    : pickValue(b.cells[key as FactorCode], metric);
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
  metric,
  openTickers,
  onOpenTicker,
  onCloseTicker,
  onOpenPortfolioDetail,
}: PortfolioFactorGridProps) {
  const openTickerSet = useMemo(() => new Set(openTickers), [openTickers]);
  const factors = data.usableFactors;

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
    rows.sort((a, b) => compareRows(a, b, signedWeightByTicker, sortBy.key, metric, sortBy.dir));
    return rows;
  }, [filteredRows, sortBy, metric, signedWeightByTicker]);

  const totalRow = useMemo(
    () => buildTotalRow(filteredRows, signedWeightByTicker, factors, metric, exposure),
    [filteredRows, signedWeightByTicker, factors, metric, exposure],
  );

  // Heatmap span — anchor on max |value| across both stock rows AND the
  // total row so the total cell shading is visually consistent with the rest.
  const colSpans = useMemo(() => {
    const m = new Map<FactorCode, number>();
    for (const f of factors) {
      let max = 0;
      for (const r of filteredRows) {
        const v = pickValue(r.cells[f], metric);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      const tot = totalRow.cells[f]?.value;
      if (tot !== null && tot !== undefined && Number.isFinite(tot) && Math.abs(tot) > max) {
        max = Math.abs(tot);
      }
      m.set(f, Math.max(max, 1e-6));
    }
    return m;
  }, [factors, filteredRows, metric, totalRow]);

  const summarySpans = useMemo(() => {
    const out: Record<SummarySortKey, number> = {
      alpha: 1e-6,
      alphaT: 1,
      alphaCi: 1e-6,
      residual: 1e-6,
      realizedVol: 1e-6,
      rSquared: 1e-6,
    };
    for (const k of SUMMARY_KEYS) {
      if (k === "alphaT") continue;
      let max = 0;
      for (const r of filteredRows) {
        const v = summaryValue(r, k);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      out[k] = Math.max(max, 1e-6);
    }
    return out;
  }, [filteredRows]);

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
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {SUMMARY_LABELS[k]}
                    </span>
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
                  title={`${def.label}\n${def.description}\n\nClick to sort rows by this column.`}
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
                    style={headerButtonBase}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{def.shortLabel}</span>
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
                  const v = summaryValue(row, k);
                  const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                  const bg = ((): string => {
                    if (v === null || !Number.isFinite(v)) return "rgba(255,255,255,0.02)";
                    if (k === "alpha" || k === "residual") {
                      return heatSignedBloomberg(v, summarySpans[k]);
                    }
                    if (k === "alphaT") return heatTStatBloomberg(v);
                    if (k === "realizedVol") return heatSequentialBloomberg(v, summarySpans.realizedVol, "red");
                    if (k === "rSquared") return heatSequentialBloomberg(v, 1, "green");
                    return "transparent";
                  })();
                  const lowFit = k === "rSquared" && v !== null && Number.isFinite(v) && v < 0.3;
                  const color =
                    v === null || !Number.isFinite(v)
                      ? "var(--text-muted)"
                      : lowFit
                        ? "var(--text-muted)"
                        : k === "alphaCi"
                          ? "var(--text-primary)"
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
                      {formatSummaryValue(v, k)}
                    </td>
                  );
                })}
                {factors.map((code) => {
                  const cell = row.cells[code];
                  const value = pickValue(cell, metric);
                  const span = colSpans.get(code) ?? 1;
                  const bg =
                    value === null
                      ? "rgba(255,255,255,0.02)"
                      : heatSignedBloomberg(value, span);
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
                      {formatValue(value, metric)}
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
                const v = totalRow.summary[k];
                const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                const bg = ((): string => {
                  if (v === null || !Number.isFinite(v)) return "rgba(240,182,93,0.10)";
                  if (k === "alpha" || k === "residual") return heatSignedBloomberg(v, summarySpans[k]);
                  if (k === "alphaT") return heatTStatBloomberg(v);
                  if (k === "realizedVol") return heatSequentialBloomberg(v, summarySpans.realizedVol, "red");
                  if (k === "rSquared") return heatSequentialBloomberg(v, 1, "green");
                  return "transparent";
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
                  >
                    {formatSummaryValue(v, k)}
                  </td>
                );
              })}
              {factors.map((code) => {
                const tot = totalRow.cells[code];
                const value = tot?.value ?? null;
                const span = colSpans.get(code) ?? 1;
                const bg =
                  value === null
                    ? "rgba(240,182,93,0.10)"
                    : heatSignedBloomberg(value, span);
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
                      metric === "risk"
                        ? `${getFactorDef(code).label}: portfolio-level risk contribution from /exposure (true OLS, not weighted sum).`
                        : `${getFactorDef(code).label}: Σ wᵢ × per-stock value (linear under OLS — exact).`
                    }
                  >
                    {formatValue(value, metric)}
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
