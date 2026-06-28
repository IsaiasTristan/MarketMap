/**
 * Bulk-CSV delivery (Ultimate tier). One call returns the whole global
 * universe as CSV; we filter to our reference set in the ingestion layer.
 * Used for the weekly full-universe pull and the Leg-B backfill so we avoid
 * ~3,000 per-symbol calls per endpoint.
 */
import { fmpGetCsv, num, str } from "./fmp-client";
import type { RatingDistribution } from "./types";

export interface BulkRatingConsensusRow {
  ticker: string;
  distribution: RatingDistribution;
}

export interface BulkPriceTargetSummaryRow {
  ticker: string;
  lastMonthCount: number | null;
  lastMonthAvg: number | null;
  lastQuarterCount: number | null;
  lastQuarterAvg: number | null;
  lastYearCount: number | null;
  lastYearAvg: number | null;
  allTimeCount: number | null;
  allTimeAvg: number | null;
}

type CsvRow = Record<string, string>;

/** /stable/upgrades-downgrades-consensus-bulk — current rating distribution for all symbols. */
export async function fetchUpgradesDowngradesConsensusBulk(
  part = 0,
): Promise<BulkRatingConsensusRow[]> {
  const rows = await fmpGetCsv<CsvRow>("/stable/upgrades-downgrades-consensus-bulk", { part });
  return rows
    .map((r): BulkRatingConsensusRow | null => {
      const ticker = str(r.symbol);
      if (!ticker) return null;
      return {
        ticker: ticker.toUpperCase(),
        distribution: {
          strongBuy: num(r.strongBuy) ?? 0,
          buy: num(r.buy) ?? 0,
          hold: num(r.hold) ?? 0,
          sell: num(r.sell) ?? 0,
          strongSell: num(r.strongSell) ?? 0,
          consensus: str(r.consensus),
        },
      };
    })
    .filter((r): r is BulkRatingConsensusRow => r !== null);
}

/** /stable/price-target-summary-bulk — period-averaged targets for all symbols. */
export async function fetchPriceTargetSummaryBulk(
  part = 0,
): Promise<BulkPriceTargetSummaryRow[]> {
  const rows = await fmpGetCsv<CsvRow>("/stable/price-target-summary-bulk", { part });
  return rows
    .map((r): BulkPriceTargetSummaryRow | null => {
      const ticker = str(r.symbol);
      if (!ticker) return null;
      return {
        ticker: ticker.toUpperCase(),
        lastMonthCount: num(r.lastMonthCount),
        lastMonthAvg: num(r.lastMonthAvgPriceTarget),
        lastQuarterCount: num(r.lastQuarterCount),
        lastQuarterAvg: num(r.lastQuarterAvgPriceTarget),
        lastYearCount: num(r.lastYearCount),
        lastYearAvg: num(r.lastYearAvgPriceTarget),
        allTimeCount: num(r.allTimeCount),
        allTimeAvg: num(r.allTimeAvgPriceTarget),
      };
    })
    .filter((r): r is BulkPriceTargetSummaryRow => r !== null);
}
