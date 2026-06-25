"use client";

import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { RiskSummaryGrid } from "@/components/analysis/overview/RiskSummaryGrid";
import type { PositionRisk } from "@/server/services/risk.service";

interface HoldingsRiskTableProps {
  positions: PositionRisk[];
  portfolioTotal?: PositionRisk | null;
  dailyPnlByTicker?: Map<string, number>;
  loading?: boolean;
}

export function HoldingsRiskTable({
  positions,
  portfolioTotal,
  dailyPnlByTicker,
  loading,
}: HoldingsRiskTableProps) {
  return (
    <ChartCard
      title="Risk Summary"
      subtitle="Vol & Sharpe by position · 1-day 95% VaR / CVaR · units in column headers"
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
        <RiskSummaryGrid
          rows={positions}
          footerRow={portfolioTotal ?? undefined}
          searchFields={(r) => `${r.ticker} ${r.name}`}
          dailyPnlByTicker={dailyPnlByTicker}
          pageSize={50}
          exportFilename="holdings-risk.csv"
        />
      )}
    </ChartCard>
  );
}
