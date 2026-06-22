"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { Donut, type DonutSlice } from "@/components/analysis/ui/Donut";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

type AllocView = "byPosition" | "byReturn" | "byRisk" | "bySector";
type AllocHorizon = "1D" | "5D" | "1M" | "6M" | "1Y" | "2Y" | "5Y";

type PnlData = {
  summary: {
    totalValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
    mtdPnl: number;
    mtdPnlPct: number;
    qtdPnl: number;
    qtdPnlPct: number;
    ytdPnl: number;
    ytdPnlPct: number;
    netValue: number;
  };
  positions: PositionRow[];
  allocation: {
    byPosition: AllocSlice[];
    bySector: AllocSlice[];
  };
  contributors: PositionRow[];
  detractors: PositionRow[];
};

type PositionRow = {
  ticker: string;
  name: string;
  sector: string | null;
  isShort: boolean;
  marketValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  weight: number;
  adv20d: number;
  daysToLiquidate: number;
  shares: number;
  currentPrice: number;
};

type AllocSlice = { name: string; value: number; pct: number };

type ReturnRiskAlloc = {
  horizon: AllocHorizon;
  byReturn: {
    name: string;
    value: number;
    signed: number;
    negative: boolean;
    marketValue: number;
  }[];
  byRisk: {
    name: string;
    value: number;
    pct: number;
    dollar: number;
    negative: false;
    marketValue: number;
  }[];
  totals: {
    returnPct: number;
    returnDollar: number;
    varDollar: number;
    varPct: number;
    grossValue: number;
  };
};

const ALLOC_VIEWS: { id: AllocView; label: string }[] = [
  { id: "byPosition", label: "Position" },
  { id: "byReturn", label: "Return" },
  { id: "byRisk", label: "Risk" },
  { id: "bySector", label: "Sector" },
];

const HORIZON_OPTIONS: AllocHorizon[] = ["1D", "5D", "1M", "6M", "1Y", "2Y", "5Y"];

const POSITIVE_HEX = "#22c55e";
const NEGATIVE_HEX = "#ef4444";

function fmt$(n: number) {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function fmtPctSigned(n: number, decimals = 2) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(decimals)}%`;
}

/** Unsigned compact dollar formatter, e.g. `$159k`, `$2.3M`. */
function fmtCompact$(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}k`;
  return `$${abs.toFixed(0)}`;
}

const liquidityCols: Column<PositionRow>[] = [
  { key: "ticker", label: "Ticker" },
  {
    key: "marketValue",
    label: "Market Value",
    align: "right",
    sortValue: (r) => r.marketValue,
    render: (r) =>
      `$${r.marketValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  },
  {
    key: "adv20d",
    label: "20d ADV",
    align: "right",
    sortValue: (r) => r.adv20d,
    render: (r) => r.adv20d > 0 ? r.adv20d.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—",
  },
  {
    key: "weight",
    label: "Weight",
    align: "right",
    sortValue: (r) => r.weight,
    render: (r) => `${(r.weight * 100).toFixed(1)}%`,
  },
  {
    key: "daysToLiquidate",
    label: "Days to Liquidate",
    align: "right",
    sortValue: (r) => r.daysToLiquidate,
    colorize: (r) =>
      r.daysToLiquidate <= 5 ? "positive" : r.daysToLiquidate <= 15 ? "warning" : "negative",
    render: (r) =>
      r.daysToLiquidate >= 999 ? "N/A" : r.daysToLiquidate.toFixed(1),
  },
];

export function OverviewClient() {
  const { activePortfolioId } = useAnalysisStore();
  const [allocView, setAllocView] = useState<AllocView>("byPosition");
  const [horizon, setHorizon] = useState<AllocHorizon>("1D");

  const needsHorizonData = allocView === "byReturn" || allocView === "byRisk";

  const { data, isLoading, error } = useQuery<PnlData>({
    queryKey: ["pnl", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
    refetchInterval: 60_000,
  });

  const { data: rrAlloc } = useQuery<ReturnRiskAlloc>({
    queryKey: ["allocation", activePortfolioId, horizon],
    queryFn: () =>
      fetch(
        `/api/analysis/portfolio/allocation?portfolioId=${activePortfolioId}&horizon=${horizon}`,
      ).then((r) => r.json()),
    enabled: !!activePortfolioId && needsHorizonData,
    refetchInterval: 60_000,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>◈</div>
        <div style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 12 }}>
          No portfolio selected
        </div>
        <a href="/data" style={{ color: "var(--color-accent)", fontSize: 13 }}>
          Go to Data Management →
        </a>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
        <SkeletonCard height={300} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ color: "var(--color-negative)", padding: 24 }}>
        Failed to load portfolio data
      </div>
    );
  }

  const { summary, positions, allocation, contributors, detractors } = data;

  const dailyPos = summary.dailyPnl >= 0;
  const mtdPos = summary.mtdPnl >= 0;
  const qtdPos = summary.qtdPnl >= 0;
  const ytdPos = summary.ytdPnl >= 0;

  const contribData = [
    ...detractors.slice().reverse().map((p) => ({ ...p, _type: "detractor" as const })),
    ...contributors.map((p) => ({ ...p, _type: "contributor" as const })),
  ];

  // ── Donut slice composition per dimension ────────────────────────────
  let donutSlices: DonutSlice[] = [];
  let centerLabel = "";
  let centerSub = "";
  let centerColor: string | undefined;
  // Recharts pie tooltip formatter signature: (value, name, item). `item.payload`
  // exposes the original slice so per-dimension tooltips can read signed return
  // or the dollar/pct split for risk.
  let tooltipFormatter: (
    value: unknown,
    name?: string | number,
    entry?: unknown,
  ) => string = (v) => `${(v as number).toFixed(1)}%`;
  let dimensionLoading = false;

  if (allocView === "byPosition") {
    const items = (allocation.byPosition ?? []).slice().sort((a, b) => b.value - a.value);
    donutSlices = items.map((s) => ({
      name: s.name,
      value: s.value,
      secondary: `${(s.pct * 100).toFixed(1)}%`,
    }));
    centerLabel = fmtCompact$(summary.totalValue);
    centerSub = "Total Value";
    tooltipFormatter = (v) => fmtCompact$(v as number);
  } else if (allocView === "bySector") {
    const items = (allocation.bySector ?? []).slice().sort((a, b) => b.value - a.value);
    donutSlices = items.map((s) => ({
      name: s.name,
      value: s.value,
      secondary: `${(s.pct * 100).toFixed(1)}%`,
    }));
    centerLabel = fmtCompact$(summary.totalValue);
    centerSub = "Total Value";
    tooltipFormatter = (v) => fmtCompact$(v as number);
  } else if (allocView === "byReturn") {
    if (!rrAlloc) {
      dimensionLoading = true;
    } else {
      const items = rrAlloc.byReturn.slice().sort((a, b) => b.value - a.value);
      donutSlices = items.map((s) => ({
        name: s.name,
        value: s.value,
        negative: s.negative,
        secondary: fmtPctSigned(s.signed),
      }));
      centerLabel = fmtPctSigned(rrAlloc.totals.returnPct);
      centerSub = `Total Return (${rrAlloc.horizon})`;
      centerColor = rrAlloc.totals.returnPct >= 0 ? POSITIVE_HEX : NEGATIVE_HEX;
      tooltipFormatter = (_v, _n, entry) => {
        const p = (entry as { payload?: { signed?: number } } | undefined)?.payload;
        return p && typeof p.signed === "number"
          ? fmtPctSigned(p.signed)
          : `${((_v as number) * 100).toFixed(2)}%`;
      };
    }
  } else if (allocView === "byRisk") {
    if (!rrAlloc) {
      dimensionLoading = true;
    } else {
      const items = rrAlloc.byRisk.slice().sort((a, b) => b.value - a.value);
      donutSlices = items.map((s) => ({
        name: s.name,
        value: s.value,
        secondary: `${fmtCompact$(s.dollar)} / ${(s.pct * 100).toFixed(1)}%`,
      }));
      centerLabel = fmtCompact$(rrAlloc.totals.varDollar);
      centerSub = `${(rrAlloc.totals.varPct * 100).toFixed(2)}% Total VaR (${rrAlloc.horizon})`;
      tooltipFormatter = (_v, _n, entry) => {
        const p = (entry as { payload?: { dollar?: number; pct?: number } } | undefined)?.payload;
        return p && typeof p.dollar === "number" && typeof p.pct === "number"
          ? `${fmtCompact$(p.dollar)} (${(p.pct * 100).toFixed(1)}%)`
          : "";
      };
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Level 1: P&L Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <MetricCard
          label="Daily P&L"
          value={fmt$(summary.dailyPnl)}
          subValue={fmtPct(summary.dailyPnlPct)}
          valueColor={dailyPos ? "positive" : "negative"}
        />
        <MetricCard
          label="MTD P&L"
          value={fmt$(summary.mtdPnl)}
          subValue={fmtPct(summary.mtdPnlPct)}
          valueColor={mtdPos ? "positive" : "negative"}
        />
        <MetricCard
          label="QTD P&L"
          value={fmt$(summary.qtdPnl)}
          subValue={fmtPct(summary.qtdPnlPct)}
          valueColor={qtdPos ? "positive" : "negative"}
        />
        <MetricCard
          label="YTD P&L"
          value={fmt$(summary.ytdPnl)}
          subValue={fmtPct(summary.ytdPnlPct)}
          valueColor={ytdPos ? "positive" : "negative"}
        />
      </div>

      {/* Level 2: Contributors + Allocation */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Contributors / Detractors */}
        <ChartCard title="Top Contributors & Detractors" subtitle="Daily P&L by position">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              layout="vertical"
              data={contribData}
              margin={{ left: 20, right: 20, top: 0, bottom: 0 }}
            >
              <XAxis
                type="number"
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="ticker"
                tick={{ fontSize: 11, fill: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}
                axisLine={false}
                tickLine={false}
                width={50}
              />
              <ReferenceLine x={0} stroke="var(--bg-border)" />
              <Tooltip
                formatter={(v) => [fmt$(v as number), "Daily P&L"]}
                contentStyle={bbTooltipStyle}
                labelStyle={{ color: "#fff" }}
                itemStyle={{ color: "var(--text-secondary)" }}
              />
              <Bar dataKey="dailyPnl" radius={0}>
                {contribData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.dailyPnl >= 0 ? "#22c55e" : "#ef4444"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Capital Allocation Donut */}
        <ChartCard
          title="Capital Allocation"
          action={
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {/* Horizon selector — only meaningful for Return / Risk */}
              {needsHorizonData && (
                <div style={{ display: "flex", gap: 2 }}>
                  {HORIZON_OPTIONS.map((h) => (
                    <button
                      key={h}
                      onClick={() => setHorizon(h)}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 3,
                        border: "none",
                        cursor: "pointer",
                        fontSize: 10,
                        fontFamily: "var(--font-mono, monospace)",
                        background:
                          horizon === h ? "var(--color-accent)" : "var(--bg-elevated)",
                        color: horizon === h ? "#fff" : "var(--text-secondary)",
                      }}
                    >
                      {h}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 4 }}>
                {ALLOC_VIEWS.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setAllocView(v.id)}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      border: "none",
                      cursor: "pointer",
                      fontSize: 11,
                      background: allocView === v.id ? "var(--color-accent)" : "var(--bg-elevated)",
                      color: allocView === v.id ? "#fff" : "var(--text-secondary)",
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          {dimensionLoading ? (
            <div
              style={{
                height: 280,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-secondary)",
                fontSize: 12,
              }}
            >
              Loading {allocView === "byReturn" ? "returns" : "risk"}…
            </div>
          ) : (
            <Donut
              data={donutSlices}
              centerLabel={centerLabel}
              centerSub={centerSub}
              centerColor={centerColor}
              height={280}
              formatter={tooltipFormatter}
            />
          )}
        </ChartCard>
      </div>

      {/* Level 3: Liquidity table */}
      <ChartCard title="Liquidity Summary" subtitle="20-day average daily volume vs. position size">
        <DataTable
          columns={liquidityCols}
          rows={positions}
          getRowKey={(r) => r.ticker}
          searchFields={(r) => `${r.ticker} ${r.name ?? ""} ${r.sector ?? ""}`}
          pageSize={15}
          exportFilename="liquidity.csv"
        />
      </ChartCard>
    </div>
  );
}
