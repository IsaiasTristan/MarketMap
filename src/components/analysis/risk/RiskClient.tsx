"use client";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { Heatmap } from "@/components/analysis/ui/Heatmap";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import type { PositionRisk, PortfolioRisk } from "@/server/services/risk.service";

type VarMethod = "parametric" | "historical";

const posRiskCols: Column<PositionRisk>[] = [
  { key: "ticker", label: "Ticker", sortValue: (r) => r.ticker },
  {
    key: "weight",
    label: "Weight",
    align: "right",
    sortValue: (r) => r.weight,
    render: (r) => `${(r.weight * 100).toFixed(1)}%`,
  },
  {
    key: "varDollar95",
    label: "VaR 95%",
    align: "right",
    sortValue: (r) => r.varDollar95,
    render: (r) => `$${r.varDollar95.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    colorize: (r) =>
      r.varDollar95 > 10000 ? "negative" : r.varDollar95 > 5000 ? "warning" : "positive",
  },
  {
    key: "varDollar99",
    label: "VaR 99%",
    align: "right",
    sortValue: (r) => r.varDollar99,
    render: (r) => `$${r.varDollar99.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  },
  {
    key: "vol21d",
    label: "Vol 21d",
    align: "right",
    sortValue: (r) => r.vol21d,
    render: (r) => `${(r.vol21d * 100).toFixed(1)}%`,
  },
  {
    key: "vol63d",
    label: "Vol 63d",
    align: "right",
    sortValue: (r) => r.vol63d,
    render: (r) => `${(r.vol63d * 100).toFixed(1)}%`,
  },
  {
    key: "vol252d",
    label: "Vol 252d",
    align: "right",
    sortValue: (r) => r.vol252d,
    render: (r) => `${(r.vol252d * 100).toFixed(1)}%`,
  },
  {
    key: "beta",
    label: "Beta (adj.)",
    align: "right",
    sortValue: (r) => r.beta,
    render: (r) => r.beta.toFixed(2),
    colorize: (r) =>
      r.beta > 1.5 ? "negative" : r.beta > 1.1 ? "warning" : "positive",
  },
];

export function RiskClient() {
  const { activePortfolioId } = useAnalysisStore();
  const qc = useQueryClient();
  const [varMethod, setVarMethod] = useState<VarMethod>("parametric");

  // Auto-sync: ingest benchmark prices (SP500/NASDAQ/DOW) and portfolio security
  // prices on first mount for the active portfolio. This is what populates
  // BenchmarkPriceHistory (needed for vol decomp) and PriceHistory (needed for
  // drawdown + vol calculations). Uses a per-render ref so it fires once per mount.
  const syncedRef = useRef<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!activePortfolioId) return;
    if (syncedRef.current === activePortfolioId) return;
    syncedRef.current = activePortfolioId;

    setSyncing(true);
    setSyncError(null);
    fetch(`/api/analysis/data/refresh?portfolioId=${activePortfolioId}`, { method: "POST" })
      .then((r) => r.json())
      .then((d: { errors?: string[] }) => {
        if (d.errors && d.errors.length > 0) {
          setSyncError(d.errors.slice(0, 2).join(" · "));
        }
        // Invalidate all risk data so charts re-fetch with fresh prices.
        qc.invalidateQueries({ queryKey: ["port-risk"] });
        qc.invalidateQueries({ queryKey: ["pos-risk"] });
        qc.invalidateQueries({ queryKey: ["correlation"] });
      })
      .catch((e: Error) => setSyncError(e.message))
      .finally(() => setSyncing(false));
  }, [activePortfolioId, qc]);

  const { data: posData, isLoading: posLoading } = useQuery<{
    positions: PositionRisk[];
    portfolioValue: number;
  }>({
    queryKey: ["pos-risk", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/risk/position-risk?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId && !syncing,
  });

  const { data: portData, isLoading: portLoading } = useQuery<{
    risk: PortfolioRisk;
    series: { dates: string[]; drawdown: number[]; rollingVol252: number[] };
  }>({
    queryKey: ["port-risk", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/risk/portfolio-risk?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId && !syncing,
  });

  const { data: corrData, isLoading: corrLoading } = useQuery<{
    tickers: string[];
    matrix: number[][];
  }>({
    queryKey: ["correlation", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/risk/correlation?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId && !syncing,
  });

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to view risk analytics.
        </div>
      </div>
    );
  }

  const risk = portData?.risk;
  const series = portData?.series;
  const isLoading = posLoading || portLoading || syncing;

  const varDollar95 =
    varMethod === "parametric" ? risk?.varParametric95 : risk?.varHistorical95;
  const varDollar99 =
    varMethod === "parametric" ? risk?.varParametric99 : risk?.varHistorical99;

  const ddChartData = series?.dates?.map((d, i) => ({
    date: d,
    drawdown: series.drawdown[i] != null ? series.drawdown[i] * 100 : null,
  })) ?? [];

  const rollingVolData = series?.dates?.map((d, i) => ({
    date: d,
    vol: series.rollingVol252[i] != null ? series.rollingVol252[i] * 100 : null,
  })) ?? [];

  const corrCells = corrData
    ? corrData.tickers.flatMap((y, i) =>
        corrData.tickers.map((x, j) => ({
          x,
          y,
          value: corrData.matrix[i]?.[j] ?? 0,
        })),
      )
    : [];

  const volDecompData = risk
    ? [
        { name: "Systematic", value: risk.systematicShare * 100 },
        { name: "Idiosyncratic", value: risk.idiosyncraticShare * 100 },
      ]
    : [];

  const vol1yPct = risk?.volatility1y != null ? risk.volatility1y * 100 : null;
  const vol5yPct = risk?.volatility5y != null ? risk.volatility5y * 100 : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Risk Analytics
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Where is my risk concentrated?
        </p>
      </div>

      {/* Sync status banner */}
      {(syncing || syncError) && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px",
          borderRadius: 8,
          background: syncError ? "rgba(239,68,68,0.08)" : "rgba(99,102,241,0.08)",
          border: `1px solid ${syncError ? "rgba(239,68,68,0.2)" : "rgba(99,102,241,0.2)"}`,
          fontSize: 12,
          color: syncError ? "var(--color-negative, #ef4444)" : "var(--color-accent, #6366f1)",
        }}>
          {syncing && (
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
          )}
          {syncing
            ? "Syncing market data — ingesting benchmark prices (SP500, NASDAQ, DOW) and portfolio history…"
            : `Sync completed with warnings: ${syncError}`}
        </div>
      )}

      {/* Level 1: Risk summary cards */}
      {isLoading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16 }}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 16 }}>
          <MetricCard
            label="Portfolio VaR 95%"
            value={varDollar95 != null ? `$${Math.round(varDollar95).toLocaleString()}` : "—"}
            subValue={varMethod === "parametric" ? "Parametric · 1-day" : "Historical · 1-day"}
            valueColor="negative"
            tooltip={{
              name: "Value at Risk 95% (1-day)",
              definition: "Maximum expected 1-day portfolio loss with 95% confidence.",
              formula: varMethod === "parametric"
                ? "NAV × σ_portfolio_daily × 1.645  (full covariance matrix, 252-day σ lookback)"
                : "5th percentile of actual daily P&L over the past 252 trading days",
              goodValue: "< 2% of portfolio NAV",
            }}
          />
          <MetricCard
            label="CVaR 95%"
            value={risk?.cvar95 != null ? `$${Math.round(risk.cvar95).toLocaleString()}` : "—"}
            subValue="Expected Shortfall · 1-day"
            valueColor="negative"
            tooltip={{
              name: "Expected Shortfall (CVaR) 95%",
              definition: "Mean loss on the worst 5% of days — measures tail risk beyond VaR.",
              formula: "Mean(daily P&L | P&L < VaR threshold)  — 252-day window",
              goodValue: "Ideally < 1.5× VaR",
            }}
          />
          <MetricCard
            label="Max Drawdown"
            value={risk?.maxDrawdown != null ? `${(risk.maxDrawdown * 100).toFixed(1)}%` : "—"}
            subValue={risk?.maxDrawdownDuration != null ? `${risk.maxDrawdownDuration} trading days` : undefined}
            valueColor="negative"
            tooltip={{
              name: "Maximum Drawdown",
              definition: "Largest peak-to-trough decline in portfolio NAV over the full available history (up to 5 years).",
              formula: "min(NAV_t / running_peak_t − 1)",
              goodValue: "< −20% is a meaningful threshold",
            }}
          />
          <MetricCard
            label="Volatility (1Y)"
            value={vol1yPct != null ? `${vol1yPct.toFixed(1)}%` : "—"}
            subValue="Ann. · 252-day lookback"
            valueColor={
              vol1yPct == null ? "default" : vol1yPct > 25 ? "negative" : vol1yPct > 15 ? "warning" : "positive"
            }
            tooltip={{
              name: "Realized Volatility (1 Year)",
              definition: "Annualized standard deviation of daily portfolio returns over the most recent 252 trading days.",
              formula: "std(daily returns, last 252d) × √252",
              goodValue: "< 15% (broad market ~16%)",
            }}
          />
          <MetricCard
            label="Volatility (5Y)"
            value={vol5yPct != null ? `${vol5yPct.toFixed(1)}%` : "—"}
            subValue="Ann. · up to 1260-day lookback"
            valueColor={
              vol5yPct == null ? "default" : vol5yPct > 25 ? "negative" : vol5yPct > 15 ? "warning" : "positive"
            }
            tooltip={{
              name: "Realized Volatility (5 Year)",
              definition: "Annualized standard deviation of daily portfolio returns over all available history, up to 1260 trading days (5 years). Reflects long-run risk including past stress periods.",
              formula: "std(daily returns, up to 1260d) × √252",
              goodValue: "Compare to 1Y vol to detect regime changes",
            }}
          />
        </div>
      )}

      {/* VaR method control */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 4 }}>VaR Method:</span>
        {(["parametric", "historical"] as const).map((m) => (
          <button key={m} onClick={() => setVarMethod(m)} style={{ padding: "3px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 11, background: varMethod === m ? "var(--color-accent)" : "var(--bg-elevated)", color: varMethod === m ? "#fff" : "var(--text-secondary)" }}>
            {m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}>
          Both methods use a 252-day (1Y) lookback · 1-day horizon
        </span>
      </div>

      {/* Level 2: Drawdown chart + Vol decomp */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>
        <ChartCard title="Drawdown (Underwater Equity Curve)" subtitle="Up to 5 years of portfolio history">
          {ddChartData.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 240, flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {syncing ? "Syncing price history…" : "No price history available."}
              </div>
              {!syncing && (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  Go to the Data tab and run a refresh, or wait for the auto-sync to complete.
                </div>
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={ddChartData} margin={{ left: 0, right: 0 }}>
                <defs>
                  <linearGradient id="ddgrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickFormatter={(d) => d.slice(0, 7)} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `${(v as number).toFixed(0)}%`} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} />
                <ReferenceLine y={0} stroke="var(--bg-border)" />
                <Tooltip
                  contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => [`${(v as number).toFixed(2)}%`, "Drawdown"]}
                />
                <Area type="monotone" dataKey="drawdown" stroke="#ef4444" fill="url(#ddgrad)" strokeWidth={1.5} dot={false} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Volatility Sources" subtitle="% of portfolio variance explained">
          {volDecompData.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <PieChart width={180} height={180}>
                <Pie data={volDecompData} cx={90} cy={90} innerRadius={50} outerRadius={80} dataKey="value">
                  <Cell fill="#6366f1" />
                  <Cell fill="#22c55e" />
                </Pie>
                <Tooltip
                  formatter={(v) => [`${(v as number).toFixed(1)}%`]}
                  contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8, fontSize: 12 }}
                />
              </PieChart>
              {volDecompData.map((d, i) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: i === 0 ? "#6366f1" : "#22c55e" }} />
                  {d.name}: {d.value.toFixed(1)}%
                </div>
              ))}
              {risk?.systematicShare === 0 && (
                <div style={{ fontSize: 11, color: "var(--color-warning, #f0b65d)", marginTop: 8, textAlign: "center", padding: "0 8px" }}>
                  Showing 100% idiosyncratic — benchmark data is loading or unavailable.
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, textAlign: "center" }}>
                Diversification benefit vs. stressed:<br />
                ${risk?.diversificationBenefit != null ? Math.round(risk.diversificationBenefit).toLocaleString() : "—"}
              </div>
            </div>
          ) : (
            <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 24, textAlign: "center" }}>
              Insufficient data
            </div>
          )}
        </ChartCard>
      </div>

      {/* Rolling vol */}
      {rollingVolData.some((d) => d.vol !== null) && (
        <ChartCard title="Rolling 252-Day Annualized Volatility" subtitle="Starts once 252 days of history are available">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={rollingVolData} margin={{ left: 0, right: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickFormatter={(d) => d.slice(0, 7)} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `${(v as number).toFixed(0)}%`} tick={{ fontSize: 10, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} />
              <ReferenceLine y={16} stroke="var(--bg-border)" strokeDasharray="3 3" label={{ value: "Market ~16%", fontSize: 10, fill: "var(--text-muted)" }} />
              <Tooltip contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8, fontSize: 12 }} formatter={(v) => [`${(v as number).toFixed(2)}%`, "Annualized Vol"]} />
              <Line type="monotone" dataKey="vol" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Level 3: Position risk table */}
      <ChartCard title="Position-Level Risk" subtitle="1-day VaR · 252-day vol windows">
        <DataTable
          columns={posRiskCols}
          rows={posData?.positions ?? []}
          getRowKey={(r) => r.ticker}
          searchFields={(r) => `${r.ticker} ${r.name}`}
          pageSize={20}
          exportFilename="position-risk.csv"
        />
      </ChartCard>

      {/* Correlation heatmap */}
      {corrData && corrData.tickers.length > 0 && (
        <ChartCard title="Return Correlation Matrix" subtitle="252-day rolling daily returns">
          {corrLoading ? (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
          ) : (
            <Heatmap
              cells={corrCells}
              xLabels={corrData.tickers}
              yLabels={corrData.tickers}
              minValue={-1}
              maxValue={1}
              cellSize={Math.max(28, Math.min(48, Math.floor(500 / corrData.tickers.length)))}
            />
          )}
        </ChartCard>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
