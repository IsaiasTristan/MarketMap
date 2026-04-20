"use client";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Gauge } from "@/components/analysis/ui/Gauge";
import { Heatmap } from "@/components/analysis/ui/Heatmap";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { ConcentrationMetrics } from "@/server/services/concentration.service";

const SECTOR_COLORS = [
  "#6366f1", "#22c55e", "#f59e0b", "#38bdf8",
  "#e879f9", "#fb923c", "#84cc16", "#06b6d4",
];

export function ConcentrationClient() {
  const { activePortfolioId } = useAnalysisStore();

  const { data, isLoading } = useQuery<ConcentrationMetrics>({
    queryKey: ["concentration", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/concentration/metrics?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to view concentration metrics.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  const corrCells = data
    ? data.tickers.flatMap((y, i) =>
        data.tickers.map((x, j) => ({
          x,
          y,
          value: data.corrMatrix[i]?.[j] ?? 0,
        })),
      )
    : [];

  const hhiLabel = data
    ? data.hhi < 0.10
      ? "Diversified"
      : data.hhi < 0.18
        ? "Moderate"
        : "Concentrated"
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Concentration
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          How diversified am I really?
        </p>
      </div>

      {/* Level 1: Headline cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, alignItems: "start" }}>
        {/* HHI Gauge */}
        <div style={{ background: "var(--bg-surface)", border: "1px solid var(--bg-border)", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            HHI Score
          </div>
          {data ? (
            <Gauge
              value={data.hhi}
              max={0.3}
              zones={[
                { label: "Diversified", max: 0.33, color: "var(--color-positive)" },
                { label: "Moderate", max: 0.6, color: "var(--color-warning)" },
                { label: "Concentrated", max: 1, color: "var(--color-negative)" },
              ]}
              label={data.hhi.toFixed(3)}
              sublabel={hhiLabel}
              size={140}
            />
          ) : null}
        </div>

        <MetricCard
          label="Effective N"
          value={data ? data.effectiveN.toFixed(1) : "—"}
          subValue={data ? `of ${data.positionCount} actual positions` : undefined}
          tooltip={{
            name: "Effective N",
            definition: "The equivalent number of equally-weighted independent positions. Lower means more concentration.",
            formula: "1 / HHI",
            goodValue: "Higher is better",
          }}
        />
        <MetricCard
          label="Top 5 Concentration"
          value={data ? `${(data.top5Pct * 100).toFixed(1)}%` : "—"}
          valueColor={
            data == null
              ? "default"
              : data.top5Pct > 0.6
                ? "negative"
                : data.top5Pct > 0.4
                  ? "warning"
                  : "positive"
          }
          tooltip={{
            name: "Top 5 Concentration",
            definition: "Fraction of portfolio NAV held in the 5 largest positions.",
            goodValue: "< 40%",
          }}
          tooltipCurrentValue={data ? `${(data.top5Pct * 100).toFixed(1)}%` : undefined}
          tooltipPassing={data ? data.top5Pct < 0.4 : undefined}
        />
        <MetricCard
          label="Top 10 Concentration"
          value={data ? `${(data.top10Pct * 100).toFixed(1)}%` : "—"}
          valueColor={
            data == null ? "default" : data.top10Pct > 0.8 ? "negative" : data.top10Pct > 0.6 ? "warning" : "positive"
          }
        />
      </div>

      {/* Level 2: Sector bar */}
      {data?.sectorAllocation && data.sectorAllocation.length > 0 && (
        <ChartCard title="Sector Allocation" subtitle="Long exposure by sector as % of NAV">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              layout="vertical"
              data={data.sectorAllocation}
              margin={{ left: 20, right: 40, top: 0, bottom: 0 }}
            >
              <XAxis
                type="number"
                tickFormatter={(v) => `${((v as number) * 100).toFixed(0)}%`}
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="sector"
                tick={{ fontSize: 11, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
                width={130}
              />
              <Tooltip
                formatter={(v) => [`${((v as number) * 100).toFixed(1)}%`, "Allocation"]}
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8 }}
              />
              <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                {data.sectorAllocation.map((_, i) => (
                  <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Level 3: Clustered correlation heatmap */}
      {data && data.tickers.length > 1 && corrCells.length > 0 && (
        <ChartCard
          title="Correlation Clustering Heatmap"
          subtitle="Positions grouped by co-movement. Clusters in same group represent less diversification benefit."
        >
          <Heatmap
            cells={corrCells}
            xLabels={data.tickers}
            yLabels={data.tickers}
            minValue={-1}
            maxValue={1}
            cellSize={Math.max(28, Math.min(48, Math.floor(600 / data.tickers.length)))}
          />
        </ChartCard>
      )}
    </div>
  );
}



