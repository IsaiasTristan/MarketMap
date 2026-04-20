"use client";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ChartCard, ProvenanceBadge } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { Card } from "@/components/analysis/ui/Card";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts";
import type { AttributionResult } from "@/server/services/attribution.service";
import type { TradeStats } from "@/domain/calculations/attribution";

const FACTOR_LABELS: Record<string, string> = {
  MKT_RF: "Market Beta",
  SMB: "Size",
  HML: "Value",
  MOM: "Momentum",
  RMW: "Quality",
  CMA: "Conservative (CMA)",
  alpha: "Alpha (Residual)",
};

const FACTOR_COLORS: Record<string, string> = {
  cumulative_MKT_RF: "#6366f1",
  cumulative_SMB: "#22c55e",
  cumulative_HML: "#f59e0b",
  cumulative_MOM: "#38bdf8",
  cumulative_RMW: "#e879f9",
  cumulative_CMA: "#fb923c",
  cumulativeAlpha: "#ef4444",
};

export function AttributionClient() {
  const { activePortfolioId } = useAnalysisStore();

  const { data: attribution, isLoading } = useQuery<AttributionResult>({
    queryKey: ["attribution-factor", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/attribution/factor?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  const { data: tradeStats } = useQuery<TradeStats>({
    queryKey: ["trade-stats", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/attribution/trade-stats?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to view attribution.
        </div>
      </div>
    );
  }

  if (isLoading) return <div style={{ display: "flex", flexDirection: "column", gap: 20 }}><SkeletonCard height={400} /></div>;

  const cumulativeKeys = attribution?.cumulative?.[0]
    ? Object.keys(attribution.cumulative[0]).filter((k) => k !== "date")
    : [];

  // Period summary table
  const periodRows = attribution?.periodSummary
    ? (["MTD", "QTD", "YTD"] as const).map((period) => {
        const sums = attribution.periodSummary[period];
        return { period, ...sums };
      })
    : [];

  const periodCols: Column<typeof periodRows[0]>[] = [
    { key: "period", label: "Period" },
    ...["alpha", "MKT_RF", "SMB", "HML", "MOM", "RMW", "CMA"].map((f) => ({
      key: f,
      label: FACTOR_LABELS[f] ?? f,
      align: "right" as const,
      render: (r: typeof periodRows[0]) => {
        const v = (r as Record<string, unknown>)[f] as number | undefined;
        if (v == null) return "—";
        const color = v >= 0 ? "var(--color-positive)" : "var(--color-negative)";
        return (
          <span style={{ color, fontFamily: "var(--font-jetbrains-mono, monospace)" }}>
            {v >= 0 ? "+" : ""}
            {(v * 100).toFixed(2)}%
          </span>
        );
      },
    })),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Performance Attribution
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Why did I make or lose money?
        </p>
      </div>

      {/* Level 2: Cumulative attribution stacked area — headline chart */}
      {attribution?.cumulative && attribution.cumulative.length > 0 ? (
        <ChartCard
          title="Cumulative Factor Attribution"
          subtitle="How each factor contributed to your returns over time"
          provenance={attribution.provenanceBadge ?? undefined}
        >
          <ResponsiveContainer width="100%" height={360}>
            <AreaChart data={attribution.cumulative} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                tickFormatter={(d) => d.slice(0, 7)}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                axisLine={false}
                tickLine={false}
              />
              <ReferenceLine y={0} stroke="var(--bg-border)" strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8, fontSize: 12 }}
                formatter={(v, name) => {
                  const n = v as number;
                  const key = (name as string).replace("cumulative_", "");
                  return [`${(n * 100).toFixed(2)}%`, FACTOR_LABELS[key] ?? (name as string)];
                }}
              />
              <Legend
                formatter={(v) => {
                  const key = (v as string).replace("cumulative_", "");
                  return <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{FACTOR_LABELS[key] ?? (v as string)}</span>;
                }}
              />
              {cumulativeKeys.map((key) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stackId="1"
                  stroke={FACTOR_COLORS[key] ?? "#6366f1"}
                  fill={FACTOR_COLORS[key] ?? "#6366f1"}
                  fillOpacity={0.7}
                  dot={false}
                  name={key}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      ) : (
        <Card>
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Requires at least 64 trading days of history and factor data (refresh the factor pipeline first).
          </div>
        </Card>
      )}

      {/* Period attribution table */}
      {periodRows.length > 0 && (
        <ChartCard title="Period Attribution Table" subtitle="MTD / QTD / YTD breakdown by factor">
          <DataTable
            columns={periodCols}
            rows={periodRows}
            getRowKey={(r) => r.period}
            searchable={false}
            exportFilename="period-attribution.csv"
          />
        </ChartCard>
      )}

      {/* Trade statistics */}
      {tradeStats && (
        <ChartCard title="Trade-Level Statistics" subtitle="Based on closed positions">
          {tradeStats.totalTrades === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 16 }}>
              No closed trades yet. Statistics will appear when you close positions.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
              {[
                { label: "Hit Rate", value: `${(tradeStats.hitRate * 100).toFixed(1)}%`, good: tradeStats.hitRate > 0.5 },
                { label: "Avg Win", value: `+${(tradeStats.avgWin * 100).toFixed(1)}%`, good: true },
                { label: "Avg Loss", value: `${(tradeStats.avgLoss * 100).toFixed(1)}%`, good: false },
                { label: "Payoff Ratio", value: tradeStats.payoffRatio.toFixed(2), good: tradeStats.payoffRatio > 1 },
              ].map((m) => (
                <div key={m.label} style={{ background: "var(--bg-elevated)", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {m.label}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      fontFamily: "var(--font-jetbrains-mono, monospace)",
                      color: m.good ? "var(--color-positive)" : "var(--color-negative)",
                      marginTop: 4,
                    }}
                  >
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
      )}
    </div>
  );
}


