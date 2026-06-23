"use client";

import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { Sparkline } from "@/components/analysis/ui/Sparkline";
import type { PositionRisk } from "@/server/services/risk.service";

function fmtVol(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtSharpe(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function sparkPositive(data: number[]) {
  if (data.length < 2) return undefined;
  return data[data.length - 1]! >= data[0]!;
}

const riskCols: Column<PositionRisk>[] = [
  { key: "ticker", label: "Ticker", sortValue: (r) => r.ticker },
  {
    key: "vol21d",
    label: "Vol 1mo",
    align: "right",
    sortValue: (r) => r.vol21d,
    render: (r) => fmtVol(r.vol21d),
  },
  {
    key: "vol21Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.vol21Spark}
        positive={sparkPositive(r.vol21Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "vol63d",
    label: "Vol 3mo",
    align: "right",
    sortValue: (r) => r.vol63d,
    render: (r) => fmtVol(r.vol63d),
  },
  {
    key: "vol63Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.vol63Spark}
        positive={sparkPositive(r.vol63Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "vol126d",
    label: "Vol 6mo",
    align: "right",
    sortValue: (r) => r.vol126d,
    render: (r) => fmtVol(r.vol126d),
  },
  {
    key: "vol126Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.vol126Spark}
        positive={sparkPositive(r.vol126Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "sharpe21d",
    label: "Sharpe 1mo",
    align: "right",
    sortValue: (r) => r.sharpe21d,
    colorize: (r) =>
      r.sharpe21d > 0 ? "positive" : r.sharpe21d < 0 ? "negative" : "neutral",
    render: (r) => fmtSharpe(r.sharpe21d),
  },
  {
    key: "sharpe21Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.sharpe21Spark}
        positive={sparkPositive(r.sharpe21Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "sharpe63d",
    label: "Sharpe 3mo",
    align: "right",
    sortValue: (r) => r.sharpe63d,
    colorize: (r) =>
      r.sharpe63d > 0 ? "positive" : r.sharpe63d < 0 ? "negative" : "neutral",
    render: (r) => fmtSharpe(r.sharpe63d),
  },
  {
    key: "sharpe63Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.sharpe63Spark}
        positive={sparkPositive(r.sharpe63Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "sharpe126d",
    label: "Sharpe 6mo",
    align: "right",
    sortValue: (r) => r.sharpe126d,
    colorize: (r) =>
      r.sharpe126d > 0 ? "positive" : r.sharpe126d < 0 ? "negative" : "neutral",
    render: (r) => fmtSharpe(r.sharpe126d),
  },
  {
    key: "sharpe126Spark",
    label: "",
    align: "center",
    render: (r) => (
      <Sparkline
        data={r.sharpe126Spark}
        positive={sparkPositive(r.sharpe126Spark)}
        height={24}
        width={64}
      />
    ),
  },
  {
    key: "varDollar95",
    label: "VaR 95%",
    align: "right",
    sortValue: (r) => r.varDollar95,
    render: (r) =>
      `$${r.varDollar95.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  },
  {
    key: "cvar95",
    label: "CVaR 95%",
    align: "right",
    sortValue: (r) => r.cvar95,
    render: (r) =>
      `$${r.cvar95.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
  },
];

interface HoldingsRiskTableProps {
  positions: PositionRisk[];
  loading?: boolean;
}

export function HoldingsRiskTable({ positions, loading }: HoldingsRiskTableProps) {
  return (
    <ChartCard
      title="Risk Summary"
      subtitle="Historical vol & Sharpe by position · 1-day 95% VaR / CVaR"
    >
      {loading ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: 12,
          }}
        >
          Loading risk metrics…
        </div>
      ) : (
        <DataTable
          columns={riskCols}
          rows={positions}
          getRowKey={(r) => r.ticker}
          searchFields={(r) => `${r.ticker} ${r.name}`}
          pageSize={50}
          exportFilename="holdings-risk.csv"
        />
      )}
    </ChartCard>
  );
}
