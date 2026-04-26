"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
  Customized,
} from "recharts";
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import {
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  BB_GRID_HEADER_BG,
  BB_GRID_HEADER_COLOR,
  BB_GRID_HEADER_FONT_WEIGHT,
  BB_GRID_HEADER_LETTER_SPACING,
  pickTextColor,
} from "@/components/analysis/factors/shared/bloomberg-grid";
import type { PerformanceMetrics } from "@/server/services/performance.service";

const BENCHMARKS = ["SP500", "NASDAQ", "DOW"] as const;
type Benchmark = (typeof BENCHMARKS)[number];

function fmt(n: number | null | undefined, decimals = 2, suffix = "") {
  if (n == null || isNaN(n)) return "—";
  return `${(n >= 0 ? "+" : "")}${n.toFixed(decimals)}${suffix}`;
}
function fmtPct(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

// Monthly heatmap — Bloomberg-style signed ramp
function monthColor(v: number): string {
  if (Math.abs(v) < 0.001) return "var(--bg-elevated)";
  return heatSignedBloomberg(v, 0.1);
}

function MonthlyHeatmap({ calendar }: { calendar: Record<string, number> }) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const entries = Object.entries(calendar).sort();
  const years = [...new Set(entries.map(([k]) => k.slice(0, 4)))];

  const headerCellStyle: React.CSSProperties = {
    padding: "4px 8px",
    background: BB_GRID_HEADER_BG,
    color: BB_GRID_HEADER_COLOR,
    fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
    letterSpacing: BB_GRID_HEADER_LETTER_SPACING,
    textTransform: "uppercase",
    textAlign: "center",
    borderBottom: "1px solid var(--bg-border)",
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: BB_GRID_FONT_SIZE,
          fontFamily: BB_GRID_FONT_STACK,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <thead>
          <tr>
            <th style={{ ...headerCellStyle, textAlign: "left" }}>Year</th>
            {months.map((m) => (
              <th key={m} style={headerCellStyle}>
                {m}
              </th>
            ))}
            <th style={headerCellStyle}>Total</th>
          </tr>
        </thead>
        <tbody>
          {years.map((year) => {
            const yearTotal = entries
              .filter(([k]) => k.startsWith(year))
              .reduce((nav, [, v]) => nav * (1 + v), 1) - 1;

            return (
              <tr key={year}>
                <td style={{ padding: "4px 8px", color: "var(--text-secondary)" }}>
                  {year}
                </td>
                {months.map((_, mi) => {
                  const key = `${year}-${String(mi + 1).padStart(2, "0")}`;
                  const v = calendar[key];
                  const cellBg = v != null ? monthColor(v) : "transparent";
                  return (
                    <td
                      key={mi}
                      style={{
                        padding: "4px 6px",
                        background: cellBg,
                        textAlign: "center",
                        borderRadius: 0,
                        color: v != null ? pickTextColor(cellBg) : "var(--text-muted)",
                      }}
                    >
                      {v != null ? `${(v * 100).toFixed(1)}%` : "—"}
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: "4px 8px",
                    background: yearTotal !== 0 ? monthColor(yearTotal) : "transparent",
                    textAlign: "right",
                    fontWeight: 600,
                    color:
                      yearTotal !== 0
                        ? pickTextColor(monthColor(yearTotal))
                        : "var(--text-muted)",
                  }}
                >
                  {`${(yearTotal * 100).toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Distribution chart overlay ────────────────────────────────────────────
// Rendered via recharts <Customized> so we get the chart's real pixel bounds
// and can draw σ bands + percentile lines with exact linear interpolation.

// DistributionOverlay only draws the σ background shading bands.
// All vertical reference lines (σ boundaries + percentiles) use recharts'
// built-in <ReferenceLine> which is guaranteed to render above the bars.
interface DistOverlayProps {
  offset?: { left: number; top: number; width: number; height: number };
  mu: number;
  sigma: number;
  histMin: number;
  histMax: number;
}

function DistributionOverlay({ offset, mu, sigma, histMin, histMax }: DistOverlayProps) {
  if (!offset) return null;
  const { left, top, width, height } = offset;
  const toX = (v: number) =>
    left + Math.max(0, Math.min(1, (v - histMin) / (histMax - histMin))) * width;

  const bands = [
    { x1: toX(mu - 3 * sigma), x2: toX(mu - 2 * sigma), fill: "#ef4444", opacity: 0.08 },
    { x1: toX(mu - 2 * sigma), x2: toX(mu - sigma),     fill: "#f59e0b", opacity: 0.11 },
    { x1: toX(mu - sigma),     x2: toX(mu + sigma),     fill: "var(--chart-1)", opacity: 0.13 },
    { x1: toX(mu + sigma),     x2: toX(mu + 2 * sigma), fill: "#f59e0b", opacity: 0.11 },
    { x1: toX(mu + 2 * sigma), x2: toX(mu + 3 * sigma), fill: "#ef4444", opacity: 0.08 },
  ];

  return (
    <g>
      {bands.map((b, i) => (
        <rect key={i} x={b.x1} y={top} width={Math.max(0, b.x2 - b.x1)} height={height} fill={b.fill} fillOpacity={b.opacity} />
      ))}
    </g>
  );
}

// ── Client-side histogram helper ──────────────────────────────────────────
// Computes histogram bins + normal density from a slice of daily returns.
// Mirrors the server-side returnHistogram() in domain/calculations/distribution.
function computeHistogramBins(returns: number[], numBins = 30) {
  if (returns.length < 2) return [];
  const sorted = [...returns].sort((a, b) => a - b);
  const minVal = sorted[0];
  const maxVal = sorted[sorted.length - 1];
  const range = maxVal - minVal || 0.001;
  const bw = range / numBins;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  const n = returns.length;

  const bins = Array.from({ length: numBins }, (_, i) => {
    const rangeMin = minVal + i * bw;
    const rangeMax = rangeMin + bw;
    const mid = (rangeMin + rangeMax) / 2 * 100;
    return { rangeMin, rangeMax, label: `${mid >= 0 ? "+" : ""}${mid.toFixed(2)}%`, count: 0, normalDensity: 0 };
  });

  for (const r of returns) {
    const idx = Math.min(numBins - 1, Math.floor((r - minVal) / bw));
    if (idx >= 0) bins[idx].count++;
  }
  for (const bin of bins) {
    const x = (bin.rangeMin + bin.rangeMax) / 2;
    const density = (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mean) / std) ** 2);
    bin.normalDensity = density * n * bw;
  }
  return bins;
}

// ── Distribution period config ────────────────────────────────────────────
type DistPeriod = "3M" | "9M" | "1Y" | "2Y" | "3Y" | "5Y";

const DIST_PERIODS: { id: DistPeriod; label: string; days: number }[] = [
  { id: "3M", label: "3M",  days: 63  },
  { id: "9M", label: "9M",  days: 189 },
  { id: "1Y", label: "1Y",  days: 252 },
  { id: "2Y", label: "2Y",  days: 504 },
  { id: "3Y", label: "3Y",  days: 756 },
  { id: "5Y", label: "5Y",  days: 1260 },
];

type ChartView = "cumulative" | "value" | "sharpe";

const CHART_VIEWS: { id: ChartView; label: string }[] = [
  { id: "cumulative", label: "Cumul. Return" },
  { id: "value", label: "Portfolio Value" },
  { id: "sharpe", label: "Rolling Sharpe" },
];

export function PerformanceClient() {
  const { activePortfolioId } = useAnalysisStore();
  const [benchmark, setBenchmark] = useState<Benchmark>("SP500");
  const [chartView, setChartView] = useState<ChartView>("cumulative");
  const [distPeriod, setDistPeriod] = useState<DistPeriod>("1Y");

  const { data: metrics, isLoading: mLoading } = useQuery<PerformanceMetrics | null>({
    queryKey: ["perf-metrics", activePortfolioId, benchmark],
    queryFn: () =>
      fetch(
        `/api/analysis/performance/metrics?portfolioId=${activePortfolioId}&benchmark=${benchmark}`,
      ).then((r) => (r.ok ? r.json() : null)),
    enabled: !!activePortfolioId,
  });

  const { data: series, isLoading: sLoading } = useQuery<{
    dates: string[];
    portfolioNAV: number[];
    benchmarkNAV: number[];
    drawdownSeries: number[];
    rolling12m: number[];
    rollingSharpe63d: number[];
    monthlyCalendar: Record<string, number>;
    returnHistogram: { label: string; count: number; normalDensity: number }[];
    portfolioReturns: number[];
  } | null>({
    queryKey: ["perf-series", activePortfolioId, benchmark],
    queryFn: () =>
      fetch(
        `/api/analysis/performance/returns?portfolioId=${activePortfolioId}&benchmark=${benchmark}`,
      ).then((r) => (r.ok ? r.json() : null)),
    enabled: !!activePortfolioId,
  });

  // Current portfolio value — used to anchor the Portfolio Value chart to real dollars
  const { data: portfolioCurrentValue } = useQuery<number | null>({
    queryKey: ["portfolio-current-value", activePortfolioId],
    queryFn: async () => {
      if (!activePortfolioId) return null;
      const r = await fetch(`/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`);
      if (!r.ok) return null;
      const d = await r.json();
      return typeof d?.summary?.totalValue === "number" ? (d.summary.totalValue as number) : null;
    },
    enabled: !!activePortfolioId,
    staleTime: 60_000,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to view performance analytics.
        </div>
      </div>
    );
  }

  const isLoading = mLoading || sLoading;

  // Build sharpeData at the top level so both the metric card and the chart
  // derive from the exact same array — guaranteeing they always agree.
  const sharpeData = series?.dates?.map((d, i) => ({
    date: d,
    sharpe: Number.isFinite(series.rollingSharpe63d[i]) ? series.rollingSharpe63d[i] : null,
  })) ?? [];
  const currentSharpe63d: number | null =
    [...sharpeData].reverse().find((d) => d.sharpe != null)?.sharpe ?? null;
  // Fall back to full-period Sharpe only if no rolling data is available yet
  const displaySharpe = currentSharpe63d ?? metrics?.sharpe ?? null;

  // NAV chart data (cumulative return %)
  const navChartData = series?.dates
    ? series.dates.map((d, i) => ({
        date: d,
        portfolio: series.portfolioNAV[i + 1] != null ? (series.portfolioNAV[i + 1] - 1) * 100 : null,
        benchmark: series.benchmarkNAV[i + 1] != null ? (series.benchmarkNAV[i + 1] - 1) * 100 : null,
      }))
    : [];

  // Portfolio value chart — scale the NAV index so the last point = actual current value.
  // Every prior point is then: currentValue × (NAV_t / NAV_final), which shows what the
  // portfolio would have been worth historically at the same allocation.
  const finalNAV = series?.portfolioNAV?.length
    ? series.portfolioNAV[series.portfolioNAV.length - 1]
    : null;
  const navScaleFactor =
    portfolioCurrentValue != null && finalNAV && finalNAV > 0
      ? portfolioCurrentValue / finalNAV
      : null;

  const fmtDollars = (v: number) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  };

  const rolling12Data = series?.dates?.map((d, i) => ({
    date: d,
    return: series.rolling12m[i] != null ? series.rolling12m[i] * 100 : null,
  })) ?? [];

  const benchLabel = benchmark === "SP500" ? "S&P 500" : benchmark === "NASDAQ" ? "NASDAQ" : "DOW";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
            Performance
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
            How good are my risk-adjusted returns?
          </p>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {BENCHMARKS.map((b) => (
            <button
              key={b}
              onClick={() => setBenchmark(b)}
              style={{
                padding: "4px 10px",
                borderRadius: 5,
                border: "1px solid var(--bg-border)",
                background: b === benchmark ? "var(--color-accent)" : "transparent",
                color: b === benchmark ? "#fff" : "var(--text-secondary)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {b === "SP500" ? "S&P 500" : b}
            </button>
          ))}
        </div>
      </div>

      {/* Level 1: Risk-adjusted metric cards */}
      {isLoading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : !metrics || "error" in (metrics as object) || metrics.sharpe == null ? (
        <div
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: "28px 32px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            Not enough price history to compute metrics
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Performance analytics require at least 63 trading days (~3 months) of stored price
            data for all positions in this portfolio. Use the{" "}
            <strong style={{ color: "var(--text-primary)" }}>Refresh</strong> button in the top bar
            or visit the <strong style={{ color: "var(--text-primary)" }}>Data</strong> tab to
            ingest price history for your holdings.
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            <MetricCard
              label="Sharpe Ratio (63d)"
              value={displaySharpe != null ? displaySharpe.toFixed(2) : "—"}
              valueColor={
                displaySharpe == null
                  ? "default"
                  : displaySharpe >= 1
                    ? "positive"
                    : displaySharpe >= 0.5
                      ? "warning"
                      : "negative"
              }
              tooltip={{
                name: "Sharpe Ratio (63-Day Rolling)",
                definition: "Risk-adjusted return over the trailing 63 trading days (~1 quarter). Matches the last point on the Rolling Sharpe chart.",
                formula: "(Ann. Return₆₃d − Rf) / Ann. Vol₆₃d",
                goodValue: "> 1.0",
              }}
              tooltipCurrentValue={displaySharpe?.toFixed(2)}
              tooltipPassing={displaySharpe != null && displaySharpe >= 1}
            />
            <MetricCard
              label="Sortino Ratio"
              value={metrics?.sortino != null ? metrics.sortino.toFixed(2) : "—"}
              valueColor={
                metrics?.sortino == null ? "default" : metrics.sortino >= 1 ? "positive" : metrics.sortino >= 0.5 ? "warning" : "negative"
              }
              tooltip={{
                name: "Sortino Ratio",
                definition: "Like Sharpe, but only penalizes downside volatility.",
                formula: "(Ann. Return − Rf) / Downside Dev.",
                goodValue: "> 1.0",
              }}
              tooltipCurrentValue={metrics?.sortino?.toFixed(2)}
              tooltipPassing={metrics?.sortino != null && metrics.sortino >= 1}
            />
            <MetricCard
              label="Calmar Ratio"
              value={metrics?.calmar != null ? metrics.calmar.toFixed(2) : "—"}
              valueColor={
                metrics?.calmar == null ? "default" : metrics.calmar >= 0.5 ? "positive" : "warning"
              }
              tooltip={{
                name: "Calmar Ratio",
                definition: "Annualized return divided by max drawdown. Measures return per unit of drawdown risk.",
                formula: "Ann. Return / |Max Drawdown|",
                goodValue: "> 0.5",
              }}
              tooltipCurrentValue={metrics?.calmar?.toFixed(2)}
              tooltipPassing={metrics?.calmar != null && metrics.calmar >= 0.5}
            />
            <MetricCard
              label="Max Drawdown"
              value={metrics?.maxDrawdown != null ? `${(metrics.maxDrawdown * 100).toFixed(1)}%` : "—"}
              valueColor="negative"
              tooltip={{
                name: "Maximum Drawdown",
                definition: "Largest peak-to-trough decline in portfolio value.",
                formula: "min(NAV_t / peak_t) − 1",
                goodValue: "< −15% is concerning",
              }}
              tooltipCurrentValue={metrics?.maxDrawdown != null ? `${(metrics.maxDrawdown * 100).toFixed(1)}%` : undefined}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            <MetricCard
              label="Up-Capture"
              value={metrics?.upCapture != null ? `${metrics.upCapture.toFixed(0)}%` : "—"}
              valueColor={
                metrics?.upCapture == null ? "default" : metrics.upCapture >= 100 ? "positive" : "warning"
              }
              tooltip={{
                name: "Up-Capture Ratio",
                definition: `Portfolio return vs ${benchLabel} on up days. >100% means outperformance in rallies.`,
                formula: `Port return (up days) / ${benchLabel} return (up days) × 100`,
                goodValue: "> 100%",
              }}
            />
            <MetricCard
              label="Down-Capture"
              value={metrics?.downCapture != null ? `${metrics.downCapture.toFixed(0)}%` : "—"}
              valueColor={
                metrics?.downCapture == null ? "default" : metrics.downCapture < 100 ? "positive" : "negative"
              }
              tooltip={{
                name: "Down-Capture Ratio",
                definition: `Portfolio return vs ${benchLabel} on down days. <100% means less losses in sell-offs.`,
                formula: `Port return (down days) / ${benchLabel} return (down days) × 100`,
                goodValue: "< 100%",
              }}
            />
            <MetricCard
              label="Ann. Alpha"
              value={metrics?.alpha != null ? fmtPct(metrics.alpha) : "—"}
              valueColor={
                metrics?.alpha == null ? "default" : metrics.alpha >= 0 ? "positive" : "negative"
              }
              tooltip={{
                name: "Jensen's Alpha",
                definition: "Annualized return above what CAPM predicts given your beta.",
                formula: "αdaily × 252 from CAPM regression",
                goodValue: "> 0%",
              }}
              tooltipCurrentValue={metrics?.alpha != null ? fmtPct(metrics.alpha) : undefined}
              tooltipPassing={metrics?.alpha != null && metrics.alpha >= 0}
            />
            <MetricCard
              label="Tracking Error"
              value={metrics?.trackingError != null ? `${(metrics.trackingError * 100).toFixed(2)}%` : "—"}
              tooltip={{
                name: "Tracking Error",
                definition: `Annualized standard deviation of daily return differences vs ${benchLabel}.`,
                formula: "std(Port − Bench) × √252",
              }}
            />
          </div>
        </>
      )}

      {/* Level 2: Main chart — toggle between views */}
      {series && (navChartData.length > 0 || series.rollingSharpe63d?.some(Number.isFinite)) && (() => {
        // Build view-specific data arrays
        // Both series are scaled by the same factor so they share the same
        // implied starting dollar value (portfolioCurrentValue / finalNAV).
        // The portfolio ends at the actual current value; the benchmark ends
        // wherever its own growth takes it — showing relative performance.
        const valueData = series.dates.map((d, i) => {
          const pNAV = series.portfolioNAV[i + 1];
          const bNAV = series.benchmarkNAV[i + 1];
          return {
            date: d,
            portfolio: pNAV != null ? (navScaleFactor != null ? pNAV * navScaleFactor : pNAV) : null,
            benchmark: bNAV != null ? (navScaleFactor != null ? bNAV * navScaleFactor : bNAV) : null,
          };
        });

        const viewAction = (
          <div style={{ display: "flex", gap: 2 }}>
            {CHART_VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setChartView(v.id)}
                style={{
                  padding: "3px 9px",
                  borderRadius: 5,
                  border: "1px solid var(--bg-border)",
                  background: chartView === v.id ? "var(--color-accent)" : "transparent",
                  color: chartView === v.id ? "#fff" : "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: chartView === v.id ? 600 : 400,
                  whiteSpace: "nowrap",
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
        );

        // Compute ending values for subtitles
        const lastCumPct = [...navChartData].reverse().find((d) => d.portfolio != null)?.portfolio;
        const lastNAV    = [...valueData].reverse().find((d) => d.portfolio != null)?.portfolio;
        const lastSharpe = [...sharpeData].reverse().find((d) => d.sharpe != null)?.sharpe;
        const fmtNAV     = (v: number) => `$${v.toFixed(3)}`;
        const fmtCum     = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

        const chartSubtitle =
          chartView === "cumulative"
            ? lastCumPct != null && lastNAV != null
              ? `Ending: ${fmtCum(lastCumPct)} total gain = ${fmtNAV(lastNAV)} per $1 invested — matches "Portfolio Value" view`
              : "Total % gain from the start of the backtest"
            : chartView === "value"
              ? navScaleFactor != null && lastNAV != null && lastCumPct != null
                ? `Ending at ${fmtNAV(lastNAV * navScaleFactor)} (actual portfolio value) · ${fmtCum(lastCumPct)} total return · same NAV as "Cumul. Return" view, scaled to real dollars`
                : lastNAV != null && lastCumPct != null
                  ? `Indexed to $1.00 at start · ending ${fmtNAV(lastNAV)} = ${fmtCum(lastCumPct)} total return`
                  : "Portfolio value scaled to current holdings"
              : lastSharpe != null
                ? `Trailing 63 trading days — last value (${lastSharpe.toFixed(2)}) matches the metric card above`
                : "Annualised Sharpe over the trailing 63 trading days (~1 quarter)";

        return (
          <ChartCard
            title={
              chartView === "cumulative"
                ? `Portfolio vs ${benchLabel} — Cumulative Return`
                : chartView === "value"
                  ? `Portfolio vs ${benchLabel} — Growth of $1`
                  : "Rolling 63-Day Sharpe Ratio"
            }
            subtitle={chartSubtitle}
            action={viewAction}
          >
            <ResponsiveContainer width="100%" height={280}>
              {chartView === "cumulative" ? (
                <LineChart data={navChartData} margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickFormatter={(d) => d.slice(0, 7)} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => `${v >= 0 ? "+" : ""}${(v as number).toFixed(0)}%`} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} />
                  <ReferenceLine y={0} stroke="var(--bg-border)" strokeDasharray="3 3" />
                  <Tooltip contentStyle={bbTooltipStyle} formatter={(v) => [`${(v as number).toFixed(2)}%`]} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />
                  <Line type="monotone" dataKey="portfolio" stroke="var(--chart-1)" strokeWidth={2} dot={false} name="Portfolio" />
                  <Line type="monotone" dataKey="benchmark" stroke="#6b7280" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name={benchLabel} />
                </LineChart>
              ) : chartView === "value" ? (
                <LineChart data={valueData} margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickFormatter={(d) => d.slice(0, 7)} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => fmtDollars(v as number)} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip
                    contentStyle={bbTooltipStyle}
                    formatter={(v) => [`$${(v as number).toLocaleString("en-US", { maximumFractionDigits: 0 })}`]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />
                  <Line type="monotone" dataKey="portfolio" stroke="var(--chart-1)" strokeWidth={2} dot={false} name="Portfolio" />
                  <Line type="monotone" dataKey="benchmark" stroke="#6b7280" strokeWidth={1.5} strokeDasharray="4 2" dot={false} name={benchLabel} />
                </LineChart>
              ) : (() => {
                  // Last date that has a valid sharpe value — used to mark the endpoint
                  const lastSharpeEntry = [...sharpeData].reverse().find((d) => d.sharpe != null);
                  return (
                    <AreaChart data={sharpeData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                      <defs>
                        <linearGradient id="sharpeGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickFormatter={(d) => d.slice(0, 7)} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={(v) => (v as number).toFixed(1)} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} />
                      <ReferenceLine y={0} stroke="var(--bg-border)" strokeDasharray="3 3" />
                      <ReferenceLine y={1} stroke="color-mix(in srgb, var(--color-positive) 35%, transparent)" strokeDasharray="4 2" label={{ value: "1.0", position: "insideTopRight", fontSize: 10, fill: "var(--color-positive)" }} />
                      {/* Current value line — ties the chart to the metric card */}
                      {displaySharpe != null && (
                        <ReferenceLine
                          y={displaySharpe}
                          stroke="#f59e0b"
                          strokeWidth={1.5}
                          strokeDasharray="6 3"
                          label={{
                            value: `Current: ${displaySharpe.toFixed(2)}`,
                            position: "insideTopLeft",
                            fontSize: 10,
                            fill: "#f59e0b",
                          }}
                        />
                      )}
                      <Tooltip
                        contentStyle={bbTooltipStyle}
                        formatter={(v) => [`${(v as number).toFixed(2)}`, "Sharpe (63d)"]}
                      />
                      {/* Main area — endpoint dot rendered separately so it's always visible */}
                      <Area type="monotone" dataKey="sharpe" stroke="var(--chart-1)" fill="url(#sharpeGrad)" strokeWidth={2} connectNulls={false} name="Sharpe (63d)"
                        dot={(props) => {
                          if (props.payload?.date !== lastSharpeEntry?.date) return <g key={props.key} />;
                          return <circle key={props.key} cx={props.cx} cy={props.cy} r={4} fill="#f59e0b" stroke="#1e1e2e" strokeWidth={2} />;
                        }}
                      />
                    </AreaChart>
                  );
                })()}
            </ResponsiveContainer>
          </ChartCard>
        );
      })()}

      {/* Monthly calendar */}
      {series?.monthlyCalendar && Object.keys(series.monthlyCalendar).length > 0 && (
        <ChartCard title="Monthly Return Calendar">
          <MonthlyHeatmap calendar={series.monthlyCalendar} />
        </ChartCard>
      )}

      {/* Return distribution */}
      {series?.portfolioReturns && series.portfolioReturns.length > 3 && (() => {
        // Slice to the selected time window (most recent N trading days)
        const allReturns = series.portfolioReturns;
        const periodCfg = DIST_PERIODS.find((p) => p.id === distPeriod)!;
        const returns = allReturns.slice(-periodCfg.days);
        const n = returns.length;
        // Recompute all stats from the sliced returns
        const bins = computeHistogramBins(returns, 30);
        const mu = returns.reduce((s, r) => s + r, 0) / n;
        const variance = returns.reduce((s, r) => s + (r - mu) ** 2, 0) / (n - 1);
        const sigma = Math.sqrt(variance);
        const sorted = [...returns].sort((a, b) => a - b);
        const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
        const percentile = (q: number) => sorted[Math.max(0, Math.min(n - 1, Math.floor(q * n)))];
        const p5  = percentile(0.05);
        const p10 = percentile(0.10);
        const p50 = percentile(0.50);
        const p90 = percentile(0.90);
        const p95 = percentile(0.95);
        const histMin = bins[0]?.rangeMin ?? 0;
        const histMax = bins[bins.length - 1]?.rangeMax ?? 0;

        // Date range covered by the slice
        const allDates = series.dates ?? [];
        const startDate = allDates[Math.max(0, allDates.length - n)];
        const endDate   = allDates[allDates.length - 1];
        const fmtDate   = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

        // Per-bar color based on which σ band the bin center falls in
        const barColor = (bin: typeof bins[0]) => {
          const center = (bin.rangeMin + bin.rangeMax) / 2;
          const dist = Math.abs(center - mu);
          if (dist < sigma)         return "var(--chart-1)"; // ±1σ — indigo
          if (dist < 2 * sigma)     return "#f59e0b"; // ±2σ — amber
          return "#ef4444";                            // beyond ±2σ — red
        };

        const statsItems = [
          { label: "μ daily",   value: pct(mu),    color: "var(--text-primary)" },
          { label: "σ daily",   value: pct(sigma), color: "var(--text-primary)" },
          { label: "−1σ / +1σ", value: `${pct(mu - sigma)} / ${pct(mu + sigma)}`, color: "var(--chart-1)" },
          { label: "−2σ / +2σ", value: `${pct(mu - 2 * sigma)} / ${pct(mu + 2 * sigma)}`, color: "#f59e0b" },
          { label: "10th %ile", value: pct(p10), color: "#22d3ee" },
          { label: "50th %ile", value: pct(p50), color: "#a3e635" },
          { label: "90th %ile", value: pct(p90), color: "#22d3ee" },
          { label: "5th %ile",  value: pct(p5),  color: "#22d3ee" },
          { label: "95th %ile", value: pct(p95), color: "#22d3ee" },
        ];

        const periodAction = (
          <div style={{ display: "flex", gap: 2 }}>
            {DIST_PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setDistPeriod(p.id)}
                style={{
                  padding: "3px 7px",
                  borderRadius: 4,
                  border: "1px solid var(--bg-border)",
                  background: distPeriod === p.id ? "var(--color-accent)" : "transparent",
                  color: distPeriod === p.id ? "#fff" : "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: distPeriod === p.id ? 600 : 400,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        );

        const actualLabel = n < periodCfg.days
          ? `${n} trading days (all available)`
          : `${n} trading days`;

        return (
          <ChartCard
            title="Return Distribution"
            subtitle={
              startDate && endDate
                ? `${fmtDate(startDate)} – ${fmtDate(endDate)} · ${actualLabel} · Skewness ${metrics?.skewness?.toFixed(2) ?? "—"} · Excess Kurt. ${metrics?.excessKurtosis?.toFixed(2) ?? "—"}`
                : `Skewness ${metrics?.skewness?.toFixed(2) ?? "—"} · Excess Kurtosis ${metrics?.excessKurtosis?.toFixed(2) ?? "—"}`
            }
            action={periodAction}
          >
            {/* Stats strip */}
            <div style={{ display: "flex", gap: 18, marginBottom: 12, flexWrap: "wrap" }}>
              {statsItems.map((item) => (
                <div key={item.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {item.label}
                  </span>
                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: item.color, fontWeight: 600 }}>
                    {item.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Legend strip */}
            <div style={{ display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
              {[
                { swatch: <rect x="0" y="0" width="20" height="10" fill="var(--chart-1)" fillOpacity={0.7} rx="2" />, label: "±1σ (68%)" },
                { swatch: <rect x="0" y="0" width="20" height="10" fill="#f59e0b" fillOpacity={0.7} rx="2" />, label: "±2σ (95%)" },
                { swatch: <rect x="0" y="0" width="20" height="10" fill="#ef4444" fillOpacity={0.7} rx="2" />, label: ">±2σ" },
                { swatch: <line x1="0" y1="5" x2="20" y2="5" stroke="#22d3ee" strokeWidth="2" strokeDasharray="6 3" />, label: "5th/10th/90th/95th %ile (exact value labelled)" },
                { swatch: <line x1="0" y1="5" x2="20" y2="5" stroke="#a3e635" strokeWidth="2" />, label: "50th %ile / median (exact)" },
                { swatch: <line x1="0" y1="5" x2="20" y2="5" stroke="#f59e0b" strokeWidth="1.5" />, label: "Normal fit" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-secondary)" }}>
                  <svg width="20" height="10">{item.swatch}</svg>
                  {item.label}
                </div>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={240}>
              {(() => {
                // Map a return value to its bin's label string so recharts can
                // position a <ReferenceLine> on the categorical x-axis.
                const binWidth = (histMax - histMin) / bins.length;
                const snapLabel = (v: number): string => {
                  const idx = Math.max(0, Math.min(bins.length - 1,
                    Math.floor((v - histMin) / binWidth)));
                  return bins[idx].label;
                };

                // σ boundary lines
                const sigmaLines = [
                  { v: mu - 3 * sigma, label: "−3σ", color: "#ef4444", pos: "insideTopRight" as const },
                  { v: mu - 2 * sigma, label: "−2σ", color: "#f59e0b", pos: "insideTopRight" as const },
                  { v: mu - sigma,     label: "−1σ", color: "var(--chart-1)", pos: "insideTopRight" as const },
                  { v: mu + sigma,     label: "+1σ", color: "var(--chart-1)", pos: "insideTopLeft"  as const },
                  { v: mu + 2 * sigma, label: "+2σ", color: "#f59e0b", pos: "insideTopLeft"  as const },
                  { v: mu + 3 * sigma, label: "+3σ", color: "#ef4444", pos: "insideTopLeft"  as const },
                ];

                // Percentile lines — label shows the EXACT value so it always matches the stats strip.
                // The hover tooltip shows the bin center (nearest bin midpoint), which can differ
                // slightly from the exact percentile — both are correct, just different representations.
                const pctLines = [
                  { v: p5,  label: pct(p5),  rank: "p5",  color: "#22d3ee", dash: "8 3", pos: "insideTopRight" as const },
                  { v: p10, label: pct(p10), rank: "p10", color: "#06b6d4", dash: "4 4", pos: "insideTopLeft"  as const },
                  { v: p50, label: pct(p50), rank: "p50", color: "#a3e635", dash: "",    pos: "insideTopRight" as const },
                  { v: p90, label: pct(p90), rank: "p90", color: "#06b6d4", dash: "4 4", pos: "insideTopRight" as const },
                  { v: p95, label: pct(p95), rank: "p95", color: "#22d3ee", dash: "8 3", pos: "insideTopLeft"  as const },
                ];

                return (
                  <ComposedChart data={bins} margin={{ left: 0, right: 8, top: 28, bottom: 0 }}>
                    <XAxis dataKey="label" tick={{ fontSize: 8, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} interval={4} />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} width={28} />
                    <Tooltip
                      contentStyle={bbTooltipStyle}
                      labelFormatter={(binLabel) => `Bin centre: ${String(binLabel ?? "")}`}
                      formatter={(v, name) => [
                        String(name ?? "") === "Normal fit" ? `${Number(v ?? 0).toFixed(1)}` : `${v} days`,
                        String(name ?? ""),
                      ]}
                    />
                    {/* σ background shading via Customized (rect elements always render) */}
                    <Customized
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      component={(props: any) => (
                        <DistributionOverlay offset={props.offset} mu={mu} sigma={sigma} histMin={histMin} histMax={histMax} />
                      )}
                    />
                    {/* Color-coded bars */}
                    <Bar dataKey="count" name="Frequency" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                      {bins.map((bin, i) => <Cell key={i} fill={barColor(bin)} fillOpacity={0.78} />)}
                    </Bar>
                    {/* Normal fit curve */}
                    <Line type="monotone" dataKey="normalDensity" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="Normal fit" isAnimationActive={false} />
                    {/* σ boundary reference lines — isFront renders above bars */}
                    {sigmaLines.map((l) => (
                      <ReferenceLine key={l.label} x={snapLabel(l.v)} stroke={l.color} strokeWidth={1.5} strokeDasharray="4 3"
                        label={{ value: l.label, position: l.pos, fontSize: 9, fill: l.color, fontFamily: "var(--font-mono,monospace)" }}
                      />
                    ))}
                    {/* Percentile reference lines */}
                    {pctLines.map((l) => (
                      <ReferenceLine key={l.label} x={snapLabel(l.v)} stroke={l.color} strokeWidth={2} strokeDasharray={l.dash || undefined}
                        label={{ value: l.label, position: l.pos, fontSize: 9, fill: l.color, fontFamily: "var(--font-mono,monospace)" }}
                      />
                    ))}
                  </ComposedChart>
                );
              })()}
            </ResponsiveContainer>
          </ChartCard>
        );
      })()}

    </div>
  );
}



