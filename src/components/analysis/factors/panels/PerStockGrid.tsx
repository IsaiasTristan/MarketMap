"use client";
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
import type { FactorCode } from "@/types/factors";
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

interface PerStockGridProps {
  data: PerStockResult;
  metric: FactorGridMetric;
  /** Tickers that currently have a floating detail panel open. */
  openTickers: ReadonlyArray<string>;
  onOpenTicker: (ticker: string) => void;
  onCloseTicker: (ticker: string) => void;
}

type SummarySortKey =
  | "alpha"
  | "alphaT"
  | "alphaCi"
  | "residual"
  | "realizedVol"
  | "rSquared";
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

const TICKER_COL_WIDTH = 96;
const META_COL_WIDTH = 140;
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
  // SE = 0 ⇒ failed regression / single-obs case. Don't show fake-precise 0.
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

function compareRows(
  a: PerStockRow,
  b: PerStockRow,
  key: PerStockGridSortKey,
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
      {dir === "desc" ? "\u25BC" : "\u25B2"}
    </span>
  );
}

export function PerStockGrid({
  data,
  metric,
  openTickers,
  onOpenTicker,
  onCloseTicker,
}: PerStockGridProps) {
  const openTickerSet = useMemo(() => new Set(openTickers), [openTickers]);
  const factors = data.usableFactors;

  const [sortBy, setSortBy] = useState<{
    key: PerStockGridSortKey;
    dir: "asc" | "desc";
  } | null>(null);

  const onHeaderClick = (key: PerStockGridSortKey) => {
    setSortBy((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  const sortedRows = useMemo(() => {
    const rows = [...data.rows];
    if (!sortBy) return rows;
    rows.sort((a, b) => compareRows(a, b, sortBy.key, metric, sortBy.dir));
    return rows;
  }, [data.rows, sortBy, metric]);

  const colSpans = useMemo(() => {
    const m = new Map<FactorCode, number>();
    for (const f of factors) {
      let max = 0;
      for (const r of data.rows) {
        const v = pickValue(r.cells[f], metric);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      m.set(f, Math.max(max, 1e-6));
    }
    return m;
  }, [factors, data.rows, metric]);

  const summarySpans = useMemo(() => {
    const m: Record<SummarySortKey, number> = {
      alpha: 1e-6,
      // alphaT uses heatTStatBloomberg(t) with a fixed |t| ramp — no span needed,
      // but the key stays in the record so Record<SummarySortKey, number> is satisfied.
      alphaT: 1,
      alphaCi: 1e-6,
      residual: 1e-6,
      realizedVol: 1e-6,
      rSquared: 1e-6,
    };
    for (const k of SUMMARY_KEYS) {
      if (k === "alphaT") continue; // no per-column span; ramp is fixed
      let max = 0;
      for (const r of data.rows) {
        const v = summaryValue(r, k);
        if (v !== null && Number.isFinite(v) && Math.abs(v) > max) max = Math.abs(v);
      }
      m[k] = Math.max(max, 1e-6);
    }
    return m;
  }, [data.rows]);

  const factorStatusMap = useMemo(() => {
    const m = new Map<FactorCode, string>();
    for (const c of data.coverage) m.set(c.code, c.status);
    return m;
  }, [data.coverage]);

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
                style={{ ...headerButtonBase, justifyContent: "flex-start", paddingLeft: 10 }}
                title="Sort by sector / sub-theme"
              >
                Sector / Sub-theme
                <SortCaret active={sortBy?.key === "sector"} dir={sortBy?.dir ?? "desc"} />
              </button>
            </th>
            {SUMMARY_KEYS.map((k, idx) => {
              const active = sortBy?.key === k;
              const tooltip = ((): string => {
                if (k === "alpha") {
                  return (
                    `Σ rolling α_t over the regression-aligned post-burn-in sample using a fixed ${data.gridRollingWindow}d rolling OLS.\n\n` +
                    `Matches the "Σ rolling α_t" residual in the per-stock detail waterfall when the chart's rolling W = ${data.gridRollingWindow}d (default).\n\n` +
                    `Note: per-factor return columns in this row use snapshot β × Σr_t — row totals therefore do not match the realised return.`
                  );
                }
                if (k === "alphaT") {
                  return (
                    `T = α / SE(α) from the snapshot OLS (intercept t-stat).\n\n` +
                    `Heat is keyed on |T| (sign-agnostic — significance is about magnitude, not direction):\n` +
                    `  |T| = 0       → darkest red (clearly not significant)\n` +
                    `  |T| ≈ 1.25    → neutral gray\n` +
                    `  |T| = 2       → ~60 % green (around the 95 % CI threshold)\n` +
                    `  |T| ≥ 3       → darkest green (highly significant)\n\n` +
                    `T = +2 and T = -2 produce the same colour; the sign is in the displayed value. ` +
                    `Sort still uses the signed t-stat so you can rank "most positive" vs "most negative".\n\n` +
                    `Factor z-scoring does not affect this number — α and SE(α) are in y-units.`
                  );
                }
                if (k === "alphaCi") {
                  return (
                    `Annualised 95 % confidence half-width for the STATIC alpha:  1.96 × SE(α) × 252.\n\n` +
                    `Reads as ±X.X% — pair with the ALPHA column (also annualised) to read the full band.`
                  );
                }
                if (k === "residual") {
                  return (
                    `Σ ε_t = Σ (y_t − predicted_t) over post burn-in from the same ${data.gridRollingWindow}d rolling OLS.\n\n` +
                    `Matches the "Unexplained Residual" segment in the per-stock detail waterfall when the chart's rolling W = ${data.gridRollingWindow}d.`
                  );
                }
                if (k === "realizedVol") {
                  return (
                    `Annualised realised volatility (σ × √252) of the stock's daily excess return over the regression-aligned sample.\n\n` +
                    `Anchor headline volatility (Phase 2 lock-in). Cells shaded red — darker red = higher vol.`
                  );
                }
                return (
                  `In-sample R² from the snapshot multivariate OLS over the regression window.\n\n` +
                  `Cells shaded green — darker green = better fit. Text tinted muted when R² < 30 % to flag low-fit rows.`
                );
              })();
              const isLastSummary = idx === SUMMARY_KEYS.length - 1;
              return (
                <th
                  key={`summary-${k}`}
                  title={tooltip}
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
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {SUMMARY_LABELS[k]}
                    </span>
                    <SortCaret active={active} dir={sortBy?.dir ?? "desc"} />
                  </button>
                </th>
              );
            })}
            {factors.map((code) => {
              const def = getFactorDef(code);
              const status = factorStatusMap.get(code);
              const active = sortBy?.key === code;
              return (
                <th
                  key={code}
                  title={`${def.label}\n${def.description}${
                    status && status !== "OK" ? `\n\nNote: ${status}` : ""
                  }\n\nClick to sort rows by this column.`}
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
                  <button
                    type="button"
                    onClick={() => onHeaderClick(code)}
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
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{def.shortLabel}</span>
                    <SortCaret active={active} dir={sortBy?.dir ?? "desc"} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isSelected = openTickerSet.has(row.ticker);
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
                  {row.ticker}
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
                {SUMMARY_KEYS.map((k, idx) => {
                  const v = summaryValue(row, k);
                  const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                  const bg = ((): string => {
                    if (v === null || !Number.isFinite(v)) return "rgba(255,255,255,0.02)";
                    if (k === "alpha" || k === "residual") {
                      return heatSignedBloomberg(v, summarySpans[k]);
                    }
                    if (k === "alphaT") {
                      // |t|-keyed ramp (sign-agnostic): 0 → red, 2 → ~60% green, 3+ → dark green.
                      return heatTStatBloomberg(v);
                    }
                    if (k === "realizedVol") {
                      return heatSequentialBloomberg(v, summarySpans.realizedVol, "red");
                    }
                    if (k === "rSquared") {
                      return heatSequentialBloomberg(v, 1, "green");
                    }
                    // alphaCi: no heat (signal already in T column).
                    return "transparent";
                  })();
                  const lowFit =
                    k === "rSquared" && v !== null && Number.isFinite(v) && v < 0.3;
                  const color =
                    v === null || !Number.isFinite(v)
                      ? "var(--text-muted)"
                      : lowFit
                        ? "var(--text-muted)"
                        : k === "alphaCi"
                          ? "var(--text-primary)"
                          : pickTextColor(bg);
                  const titleSuffix = ((): string => {
                    if ((k === "alpha" || k === "residual") && row.rollingObservationsPostBurn > 0) {
                      return `\nValid rolling-fit days summed: ${row.rollingObservationsPostBurn}`;
                    }
                    if (k === "alpha" || k === "residual") {
                      return `\nNo rolling fits available (sample too short for ${data.gridRollingWindow}d window).`;
                    }
                    if (k === "alphaT") {
                      return `\n|T| ≥ 1.96 ⇒ 95 % CI excludes 0.`;
                    }
                    if (k === "alphaCi") {
                      return `\n95 % half-width = 1.96 × SE(α) × 252.`;
                    }
                    return "";
                  })();
                  return (
                    <td
                      key={`summary-${k}`}
                      title={`${row.ticker} · ${SUMMARY_LABELS[k]} = ${formatSummaryValue(v, k)}${titleSuffix}`}
                      style={{
                        width: SUMMARY_COL_WIDTH,
                        minWidth: SUMMARY_COL_WIDTH,
                        padding: "0 6px",
                        background: isSelected
                          ? "rgba(240,182,93,0.06)"
                          : bg,
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
          {data.rows.length === 0 && (
            <tr>
              <td
                colSpan={factors.length + 2 + SUMMARY_KEYS.length}
                style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}
              >
                No stocks match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
