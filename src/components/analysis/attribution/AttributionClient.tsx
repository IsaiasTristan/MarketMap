"use client";
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { Card } from "@/components/analysis/ui/Card";
import { LogModeMethodology } from "@/components/analysis/factors/panels/LogModeMethodology";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts";
import type {
  AttributionResult,
  PeriodAttributionSummary,
  PeriodAttributionSummaryLog,
} from "@/types/factors";
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
  cumulative_MKT_RF: "var(--chart-1)",
  cumulative_SMB: "#22c55e",
  cumulative_HML: "#f59e0b",
  cumulative_MOM: "var(--chart-4)",
  cumulative_RMW: "#e879f9",
  cumulative_CMA: "#fb923c",
  cumulativeAlpha: "#ef4444",
};

export function AttributionClient() {
  const activePortfolioId = useAnalysisStore((s) => s.activePortfolioId);

  const { data: attribution, isLoading } = useQuery<AttributionResult>({
    queryKey: ["attribution-factor", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/attribution/factor?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  // Path B is the default surface across the analysis stack — when the server
  // emits log-attribution series we drive the headline + period table off the
  // geometric reconciliation. Strict-drop fallback (any 1+r ≤ 0 in the
  // window) silently degrades to Path A so the user still sees something.
  const logAvailable = !!attribution?.cumulativeLog && attribution.cumulativeLog.length > 0;
  const useLog = logAvailable;

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

  const cumulativeSeries = useLog
    ? attribution?.cumulativeLog ?? []
    : attribution?.cumulative ?? [];
  const cumulativeKeys = cumulativeSeries[0]
    ? Object.keys(cumulativeSeries[0]).filter(
        (k) => k !== "date" && k !== "cumulativePortGeometric",
      )
    : [];

  // Period summary table (1D / 5D / 1M / 3M / 6M / 1Y from engine `periods` / `periodsLog`).
  //
  // In log mode each row carries a `_total_geometric` (exp(Σ y_log) − 1) and
  // `_total_log` (Σ y_log) so the rendered "Total Excess" cell can show the
  // geometric primary with the inner log sum muted underneath.
  const periodRows: Array<Record<string, string | number>> = (() => {
    const codes = ["MKT_RF", "SMB", "HML", "MOM", "RMW", "CMA"] as const;
    if (useLog) {
      if (!attribution?.periodsLog?.length) return [];
      return (["1D", "5D", "1M", "3M", "6M", "1Y"] as const)
        .map((label) => attribution.periodsLog!.find((p) => p.label === label))
        .filter((p): p is PeriodAttributionSummaryLog => p != null)
        .map((p) => {
          const row: Record<string, string | number> = {
            period: p.label,
            alpha: p.alpha,
            _total_log: p.totalLogReturn,
            _total_geometric: p.totalGeometricReturn,
          };
          for (const code of codes) {
            row[code] = p.byFactor.find((b) => b.code === code)?.contribution ?? 0;
          }
          return row;
        });
    }
    if (!attribution?.periods?.length) return [];
    return (["1D", "5D", "1M", "3M", "6M", "1Y"] as const)
      .map((label) => attribution.periods.find((p) => p.label === label))
      .filter((p): p is PeriodAttributionSummary => p != null)
      .map((p) => {
        const row: Record<string, string | number> = {
          period: p.label,
          alpha: p.alpha,
        };
        for (const code of codes) {
          row[code] = p.byFactor.find((b) => b.code === code)?.contribution ?? 0;
        }
        return row;
      });
  })();

  const lastCumLog =
    useLog && attribution?.cumulativeLog && attribution.cumulativeLog.length > 0
      ? attribution.cumulativeLog[attribution.cumulativeLog.length - 1]!
      : null;

  const periodCols: Column<Record<string, string | number>>[] = [
    { key: "period", label: "Period" },
    // "Total Excess" leads in log mode — geometric primary + log sub-line.
    // Hidden entirely in simple-fallback mode (no geometric total to show).
    ...(useLog
      ? [
          {
            key: "_total_geometric",
            label: "Total Excess",
            align: "right" as const,
            render: (r: Record<string, string | number>) => {
              const geo = (r as Record<string, unknown>)._total_geometric as
                | number
                | undefined;
              const log = (r as Record<string, unknown>)._total_log as
                | number
                | undefined;
              if (geo == null) return "—";
              const color =
                geo >= 0 ? "var(--color-positive)" : "var(--color-negative)";
              return (
                <div
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    textAlign: "right",
                    lineHeight: 1.2,
                  }}
                  title={
                    log != null
                      ? `Σ log contribs = ${(log * 100).toFixed(2)}% → exp(.) − 1 = ${(geo * 100).toFixed(2)}%`
                      : undefined
                  }
                >
                  <div style={{ color, fontWeight: 600 }}>
                    {geo >= 0 ? "+" : ""}
                    {(geo * 100).toFixed(2)}%
                  </div>
                  {log != null && (
                    <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
                      Σ log = {(log * 100).toFixed(2)}%
                    </div>
                  )}
                </div>
              );
            },
          },
        ]
      : []),
    ...["alpha", "MKT_RF", "SMB", "HML", "MOM", "RMW", "CMA"].map((f) => ({
      key: f,
      label: FACTOR_LABELS[f] ?? f,
      align: "right" as const,
      render: (r: Record<string, string | number>) => {
        const v = (r as Record<string, unknown>)[f] as number | undefined;
        if (v == null) return "—";
        const color = v >= 0 ? "var(--color-positive)" : "var(--color-negative)";
        return (
          <span style={{ color, fontFamily: "var(--font-mono, monospace)" }}>
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
      {cumulativeSeries.length > 0 ? (
        <ChartCard
          title="Cumulative Factor Attribution"
          subtitle={
            useLog
              ? "Bars are log contributions Σ(β·ln(1+f)) + Σα; headline reconciles via exp(Σ y_log) − 1 to compounded realised excess"
              : "Arithmetic Σ of daily simple excess (log path unavailable for this window — NOT a compounded total)"
          }
          provenance={attribution?.provenanceBadge ?? undefined}
          action={
            useLog && lastCumLog ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ color: "var(--text-muted)" }}>Total Excess:</span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color:
                      lastCumLog.cumulativePortGeometric >= 0
                        ? "var(--color-positive)"
                        : "var(--color-negative)",
                  }}
                >
                  {lastCumLog.cumulativePortGeometric >= 0 ? "+" : ""}
                  {(lastCumLog.cumulativePortGeometric * 100).toFixed(2)}%
                </span>
                <LogModeMethodology
                  sumLog={lastCumLog.cumulativePortLogReturn}
                  geometric={lastCumLog.cumulativePortGeometric}
                />
              </div>
            ) : null
          }
        >
          <ResponsiveContainer width="100%" height={360}>
            <AreaChart
              data={cumulativeSeries as unknown as Array<Record<string, unknown>>}
              margin={{ left: 0, right: 0, top: 4, bottom: 0 }}
            >
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
                contentStyle={bbTooltipStyle}
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
                  stroke={FACTOR_COLORS[key] ?? "var(--chart-1)"}
                  fill={FACTOR_COLORS[key] ?? "var(--chart-1)"}
                  fillOpacity={0.7}
                  dot={false}
                  name={key}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          {useLog && lastCumLog && (
            <div
              style={{
                marginTop: 6,
                padding: "5px 10px",
                fontSize: 10,
                fontFamily: "var(--font-mono, monospace)",
                fontVariantNumeric: "tabular-nums",
                color: "var(--text-muted)",
              }}
              title={
                `Reconciliation: Σ log contribs is the additive inner sum (where stacked bars close); ` +
                `exp(Σ) − 1 is the compounded geometric realised excess shown as the headline.`
              }
            >
              Σ log contribs = {(lastCumLog.cumulativePortLogReturn * 100).toFixed(2)}%
              {"  →  "}
              exp(Σ) − 1 ={" "}
              <span
                style={{
                  color:
                    lastCumLog.cumulativePortGeometric >= 0
                      ? "var(--color-positive)"
                      : "var(--color-negative)",
                  fontWeight: 600,
                }}
              >
                {lastCumLog.cumulativePortGeometric >= 0 ? "+" : ""}
                {(lastCumLog.cumulativePortGeometric * 100).toFixed(2)}%
              </span>{" "}
              <span style={{ color: "var(--color-positive)" }}>✓</span>
              <div style={{ marginTop: 2, fontStyle: "italic" }}>
                Bars are additive in log space only; exp(component) − 1 for an individual factor does NOT sum to the geometric total.
              </div>
            </div>
          )}
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
        <ChartCard
          title="Period Attribution Table"
          subtitle={
            useLog
              ? "MTD / QTD / YTD geometric total + per-factor log contribution"
              : "MTD / QTD / YTD breakdown by factor (arithmetic Σ — log path unavailable)"
          }
        >
          <DataTable
            columns={periodCols}
            rows={periodRows}
            getRowKey={(r) => String(r.period)}
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
                <div key={m.label} style={{ background: "var(--bg-elevated)", borderRadius: 2, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {m.label}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono, monospace)",
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


