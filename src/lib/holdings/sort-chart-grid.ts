import type { HoldingRow } from "@/server/services/portfolio-holdings.service";

export interface ChartGridRow extends HoldingRow {
  absDailyMove: number;
}

/**
 * Sort holdings by absolute daily dollar P&L (largest move first).
 */
export function sortHoldingsByAbsDailyMove(
  rows: HoldingRow[],
  dailyPnlByTicker: Map<string, number>,
): ChartGridRow[] {
  return rows
    .map((row) => {
      const fromPnl = dailyPnlByTicker.get(row.ticker);
      const fallback =
        row.isShort
          ? -row.shares * (row.currentPrice - row.prevClose)
          : row.shares * (row.currentPrice - row.prevClose);
      const dailyPnl = fromPnl ?? fallback;
      return {
        ...row,
        absDailyMove: Math.abs(dailyPnl),
      };
    })
    .sort((a, b) => b.absDailyMove - a.absDailyMove);
}
