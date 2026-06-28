/** Leg B — price targets: event-level news, current consensus, period summary. */
import { fmpGetJson, num, str } from "./fmp-client";
import type {
  FmpPriceTargetConsensusRaw,
  FmpPriceTargetNewsRaw,
  FmpPriceTargetSummaryRaw,
  NormalizedPriceTargetEvent,
  PriceTargetConsensus,
} from "./types";

/** Event-level price-target changes (/stable/price-target-news). */
export async function fetchPriceTargetNews(
  symbol: string,
  limit = 1000,
): Promise<NormalizedPriceTargetEvent[]> {
  const rows = await fmpGetJson<FmpPriceTargetNewsRaw[]>("/stable/price-target-news", {
    symbol,
    limit,
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): NormalizedPriceTargetEvent | null => {
      const publishedDate = str(r.publishedDate);
      if (!publishedDate) return null;
      return {
        ticker: symbol.toUpperCase(),
        publishedDate,
        analystCompany: str(r.analystCompany),
        analystName: str(r.analystName),
        priceTarget: num(r.priceTarget),
        priceWhenPosted: num(r.priceWhenPosted),
        newsPublisher: str(r.newsPublisher),
      };
    })
    .filter((r): r is NormalizedPriceTargetEvent => r !== null);
}

/** Current price-target consensus (/stable/price-target-consensus). */
export async function fetchPriceTargetConsensus(
  symbol: string,
): Promise<PriceTargetConsensus | null> {
  const rows = await fmpGetJson<FmpPriceTargetConsensusRaw[]>("/stable/price-target-consensus", {
    symbol,
  });
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    high: num(r.targetHigh),
    low: num(r.targetLow),
    consensus: num(r.targetConsensus),
    median: num(r.targetMedian),
  };
}

/** Period-averaged price-target summary (/stable/price-target-summary). */
export async function fetchPriceTargetSummary(
  symbol: string,
): Promise<FmpPriceTargetSummaryRaw | null> {
  const rows = await fmpGetJson<FmpPriceTargetSummaryRaw[]>("/stable/price-target-summary", {
    symbol,
  });
  return (Array.isArray(rows) ? rows[0] : null) ?? null;
}
