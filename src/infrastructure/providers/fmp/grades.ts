/** Leg B — analyst grades: event-level changes, monthly distribution, consensus. */
import { fmpGetJson, isoDate, num, str } from "./fmp-client";
import type {
  FmpGradeEventRaw,
  FmpGradesConsensusRaw,
  FmpGradesHistoricalRaw,
  NormalizedRatingEvent,
  RatingDistribution,
} from "./types";

/** Event-level rating changes (/stable/grades). Deep, timestamped history. */
export async function fetchGradeEvents(symbol: string): Promise<NormalizedRatingEvent[]> {
  const rows = await fmpGetJson<FmpGradeEventRaw[]>("/stable/grades", { symbol });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): NormalizedRatingEvent | null => {
      const eventDate = isoDate(r.date);
      if (!eventDate) return null;
      return {
        ticker: symbol.toUpperCase(),
        eventDate,
        gradingCompany: str(r.gradingCompany),
        previousGrade: str(r.previousGrade),
        newGrade: str(r.newGrade),
        action: str(r.action),
      };
    })
    .filter((r): r is NormalizedRatingEvent => r !== null);
}

/** Monthly consensus distribution time series (/stable/grades-historical). */
export async function fetchGradesHistorical(
  symbol: string,
  limit = 1000,
): Promise<Array<{ date: string; distribution: RatingDistribution }>> {
  const rows = await fmpGetJson<FmpGradesHistoricalRaw[]>("/stable/grades-historical", {
    symbol,
    limit,
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const date = isoDate(r.date);
      if (!date) return null;
      return {
        date,
        distribution: {
          strongBuy: num(r.analystRatingsStrongBuy) ?? 0,
          buy: num(r.analystRatingsBuy) ?? 0,
          hold: num(r.analystRatingsHold) ?? 0,
          sell: num(r.analystRatingsSell) ?? 0,
          strongSell: num(r.analystRatingsStrongSell) ?? 0,
          consensus: null,
        } as RatingDistribution,
      };
    })
    .filter((r): r is { date: string; distribution: RatingDistribution } => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Current consensus distribution (/stable/grades-consensus). */
export async function fetchGradesConsensus(symbol: string): Promise<RatingDistribution | null> {
  const rows = await fmpGetJson<FmpGradesConsensusRaw[]>("/stable/grades-consensus", { symbol });
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    strongBuy: num(r.strongBuy) ?? 0,
    buy: num(r.buy) ?? 0,
    hold: num(r.hold) ?? 0,
    sell: num(r.sell) ?? 0,
    strongSell: num(r.strongSell) ?? 0,
    consensus: str(r.consensus),
  };
}
