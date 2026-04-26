"use client";
import { useMemo, useState } from "react";
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import type { FactorGridMetric } from "@/store/analysis";
import type {
  PerStockResult,
  PerStockFactorCell,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";

interface PerStockGridProps {
  data: PerStockResult;
  metric: FactorGridMetric;
  selectedTicker: string | null;
  onSelectTicker: (t: string | null) => void;
}

type SummarySortKey = "alpha" | "residual" | "realizedVol" | "rSquared";
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
  "residual",
  "realizedVol",
  "rSquared",
] as const;

const SUMMARY_LABELS: Record<SummarySortKey, string> = {
  alpha: "Alpha",
  residual: "Unexplained",
  realizedVol: "Realised σ",
  rSquared: "R²",
};

function summaryValue(row: PerStockRow, key: SummarySortKey): number | null {
  if (key === "alpha") return row.rollingAlphaPostBurnSum;
  if (key === "residual") return row.rollingResidualPostBurnSum;
  if (key === "realizedVol") return row.realizedAnnualizedVol;
  return row.rSquared;
}

function formatSummaryValue(v: number | null, key: SummarySortKey): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (key === "rSquared") return `${(v * 100).toFixed(0)}%`;
  if (key === "realizedVol") return `${(v * 100).toFixed(1)}%`;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

const headerCellStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "var(--bb-chrome)",
  color: "#fff",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  padding: "5px 6px",
  borderRight: "1px solid var(--bg-border)",
  textAlign: "center",
  whiteSpace: "nowrap",
  zIndex: 2,
};

const stickyLeftStyle: React.CSSProperties = {
  position: "sticky",
  left: 0,
  background: "var(--bg-surface)",
  borderRight: "1px solid var(--bg-border)",
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

export function PerStockGrid({ data, metric, selectedTicker, onSelectTicker }: PerStockGridProps) {
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
      residual: 1e-6,
      realizedVol: 1e-6,
      rSquared: 1e-6,
    };
    for (const k of SUMMARY_KEYS) {
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
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
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
                color: "#fff",
                textAlign: "left",
                paddingLeft: 0,
                background: "var(--bb-chrome)",
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
                color: "#fff",
                textAlign: "left",
                background: "var(--bb-chrome)",
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
              const tooltip =
                k === "alpha"
                  ? `Σ rolling α_t over the regression-aligned post-burn-in sample using a fixed ${data.gridRollingWindow}d rolling OLS.\n\n` +
                    `Matches the "Σ rolling α_t" residual in the per-stock detail waterfall when the chart's rolling W = ${data.gridRollingWindow}d (default).\n\n` +
                    `Note: per-factor return columns in this row use snapshot β × Σr_t — row totals therefore do not match the realised return.`
                  : k === "residual"
                    ? `Σ ε_t = Σ (y_t − predicted_t) over post burn-in from the same ${data.gridRollingWindow}d rolling OLS.\n\n` +
                      `Matches the "Unexplained Residual" segment in the per-stock detail waterfall when the chart's rolling W = ${data.gridRollingWindow}d.`
                    : k === "realizedVol"
                      ? `Realised σ × √252 of the stock's daily excess return over the regression-aligned sample.\n\n` +
                        `Anchor headline volatility (Phase 2 lock-in).`
                      : `In-sample R² from the snapshot multivariate OLS over the regression window.\n\n` +
                        `Tinted muted when < 30 % to flag low-fit rows.`;
              const isLastSummary = idx === SUMMARY_KEYS.length - 1;
              return (
                <th
                  key={`summary-${k}`}
                  title={tooltip}
                  style={{
                    ...headerCellStyle,
                    width: SUMMARY_COL_WIDTH,
                    minWidth: SUMMARY_COL_WIDTH,
                    color: "#fff",
                    padding: 0,
                    borderRight: isLastSummary
                      ? "2px solid var(--bg-border)"
                      : "1px solid var(--bg-border)",
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
                    color: status === "OK" ? "#fff" : "var(--color-warning, #f59e0b)",
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
            const isSelected = row.ticker === selectedTicker;
            return (
              <tr
                key={row.ticker}
                onClick={() => onSelectTicker(isSelected ? null : row.ticker)}
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
                    fontWeight: 600,
                    color: isSelected ? "var(--color-accent, #f0b65d)" : "var(--text-primary)",
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
                    fontSize: 10,
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
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.sector}
                  </div>
                  <div
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
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
                  const isHeat = k === "alpha" || k === "residual";
                  const isLastSummary = idx === SUMMARY_KEYS.length - 1;
                  const bg =
                    isHeat && v !== null && Number.isFinite(v)
                      ? heatSignedBloomberg(v, summarySpans[k])
                      : v === null
                        ? "rgba(255,255,255,0.02)"
                        : "transparent";
                  const lowFit =
                    k === "rSquared" && v !== null && Number.isFinite(v) && v < 0.3;
                  const color =
                    v === null || !Number.isFinite(v)
                      ? "var(--text-muted)"
                      : lowFit
                        ? "var(--text-muted)"
                        : "#e8eef7";
                  const titleSuffix =
                    (k === "alpha" || k === "residual") &&
                    row.rollingObservationsPostBurn > 0
                      ? `\nValid rolling-fit days summed: ${row.rollingObservationsPostBurn}`
                      : (k === "alpha" || k === "residual")
                        ? `\nNo rolling fits available (sample too short for ${data.gridRollingWindow}d window).`
                        : "";
                  return (
                    <td
                      key={`summary-${k}`}
                      title={`${row.ticker} · ${SUMMARY_LABELS[k]} = ${formatSummaryValue(v, k)}${titleSuffix}`}
                      style={{
                        width: SUMMARY_COL_WIDTH,
                        minWidth: SUMMARY_COL_WIDTH,
                        padding: 0,
                        background: isSelected
                          ? "rgba(240,182,93,0.06)"
                          : bg,
                        textAlign: "center",
                        fontSize: 10,
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
                        padding: 0,
                        background: bg,
                        textAlign: "center",
                        fontSize: 10,
                        color: value !== null ? "#e8eef7" : "var(--text-muted)",
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
