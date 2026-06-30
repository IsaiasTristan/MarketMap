"use client";

import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { RiskSummaryGrid } from "@/components/analysis/overview/RiskSummaryGrid";
import type { PositionRisk } from "@/server/services/risk.service";

interface HoldingsRiskTableProps {
  positions: PositionRisk[];
  portfolioTotal?: PositionRisk | null;
  benchmarks?: PositionRisk[];
  dailyPnlByTicker?: Map<string, number>;
  loading?: boolean;
  onTickerClick?: (ticker: string) => void;
}

export function HoldingsRiskTable({
  positions,
  portfolioTotal,
  benchmarks,
  dailyPnlByTicker,
  loading,
  onTickerClick,
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
          referenceRows={benchmarks}
          searchFields={(r) => `${r.ticker} ${r.name}`}
          dailyPnlByTicker={dailyPnlByTicker}
          pageSize={50}
          exportFilename="holdings-risk.csv"
          onTickerClick={onTickerClick}
        />
      )}
    </ChartCard>
  );
}
