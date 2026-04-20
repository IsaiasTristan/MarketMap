"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { Donut } from "@/components/analysis/ui/Donut";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
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
    unrealizedPnl: number;
    unrealizedPnlPct: number;
  };
  positions: PositionRow[];
  allocation: {
    byPosition: AllocSlice[];
    bySector: AllocSlice[];
    byGeography: AllocSlice[];
  };
  contributors: PositionRow[];
  detractors: PositionRow[];
};

type PositionRow = {
  ticker: string;
  name: string;
  sector: string | null;
  marketValue: number;
  dailyPnl: number;
  dailyPnlPct: number;
  weight: number;
  adv20d: number;
  daysToLiquidate: number;
  shares: number;
  entryPrice: number;
  currentPrice: number;
};

type AllocSlice = { name: string; value: number; pct: number };

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
  const [allocView, setAllocView] = useState<"byPosition" | "bySector" | "byGeography">("bySector");

  const { data, isLoading, error } = useQuery<PnlData>({
    queryKey: ["pnl", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/portfolio/pnl?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
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

  const allocSlices = allocation[allocView] ?? [];
  const allocDonutData = allocSlices
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map((s) => ({ name: s.name, value: parseFloat((s.pct * 100).toFixed(1)) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Overview
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          How is my portfolio performing?
        </p>
      </div>

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
                tick={{ fontSize: 11, fill: "var(--text-secondary)", fontFamily: "var(--font-jetbrains-mono, monospace)" }}
                axisLine={false}
                tickLine={false}
                width={50}
              />
              <ReferenceLine x={0} stroke="var(--bg-border)" />
              <Tooltip
                formatter={(v) => [fmt$(v as number), "Daily P&L"]}
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8 }}
                labelStyle={{ color: "var(--text-primary)" }}
                itemStyle={{ color: "var(--text-secondary)" }}
              />
              <Bar dataKey="dailyPnl" radius={[0, 4, 4, 0]}>
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
            <div style={{ display: "flex", gap: 4 }}>
              {(["bySector", "byPosition", "byGeography"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setAllocView(v)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    border: "none",
                    cursor: "pointer",
                    fontSize: 11,
                    background: allocView === v ? "var(--color-accent)" : "var(--bg-elevated)",
                    color: allocView === v ? "#fff" : "var(--text-secondary)",
                  }}
                >
                  {v === "byPosition" ? "Position" : v === "bySector" ? "Sector" : "Geography"}
                </button>
              ))}
            </div>
          }
        >
          <Donut
            data={allocDonutData}
            centerLabel={`$${Math.round(summary.totalValue / 1000)}k`}
            centerSub="Total Value"
            height={240}
            formatter={(v) => `${(v as number).toFixed(1)}%`}
          />
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



