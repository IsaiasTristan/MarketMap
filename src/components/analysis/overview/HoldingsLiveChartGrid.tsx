"use client";

import { useMemo, useState } from "react";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DeferUntilVisible } from "@/components/analysis/shared/DeferUntilVisible";
import { sortHoldingsByAbsDailyMove } from "@/lib/holdings/sort-chart-grid";
import type { HoldingRow } from "@/server/services/portfolio-holdings.service";
import { LivePriceChartTile } from "./LivePriceChartTile";
import { StockPriceChartModal } from "./StockPriceChartModal";

const GRID_STYLE_ID = "holdings-live-chart-grid-style";

function GridSkeleton() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
        gap: 12,
        padding: 12,
      }}
      className="holdings-live-chart-grid"
    >
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 168,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

export interface HoldingsLiveChartGridProps {
  rows: HoldingRow[];
  dailyPnlByTicker: Map<string, number>;
  loading?: boolean;
}

export function HoldingsLiveChartGrid({
  rows,
  dailyPnlByTicker,
  loading = false,
}: HoldingsLiveChartGridProps) {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  const sorted = useMemo(
    () => sortHoldingsByAbsDailyMove(rows, dailyPnlByTicker),
    [rows, dailyPnlByTicker],
  );

  const expandedRow = expandedTicker
    ? sorted.find((r) => r.ticker === expandedTicker)
    : null;

  return (
    <>
      <style>{`
        .${GRID_STYLE_ID} {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 12px;
          padding: 12px;
        }
        @media (max-width: 1200px) {
          .${GRID_STYLE_ID} {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 768px) {
          .${GRID_STYLE_ID} {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>

      <ChartCard
        title="Live Prices"
        subtitle="Intraday · sorted by |daily $ move| · refreshes every 20s"
        compact
      >
        {loading ? (
          <GridSkeleton />
        ) : sorted.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
          >
            No holdings to chart.
          </div>
        ) : (
          <div className={GRID_STYLE_ID}>
            {sorted.map((row) => (
              // Each tile mounts a Recharts ResponsiveContainer; defer the
              // off-screen ones so a large portfolio doesn't instantiate dozens
              // of charts on first paint.
              <DeferUntilVisible key={row.ticker} minHeight={168}>
                <LivePriceChartTile
                  ticker={row.ticker}
                  intradayPoints={row.intradayPoints}
                  prevClose={row.prevClose}
                  currentPrice={row.currentPrice}
                  chg1dPct={row.chg1dPct}
                  onClick={() => setExpandedTicker(row.ticker)}
                />
              </DeferUntilVisible>
            ))}
          </div>
        )}
      </ChartCard>

      {expandedRow && (
        <StockPriceChartModal
          key={expandedRow.ticker}
          ticker={expandedRow.ticker}
          liveTail={expandedRow.sparkline}
          onClose={() => setExpandedTicker(null)}
        />
      )}
    </>
  );
}
