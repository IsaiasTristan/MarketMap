/**
 * Leg B — TipRanks analyst ratings + price targets (FMP paid add-on).
 *
 * Contract verified live 2026-09-15:
 *  - /stable/tipranks-search?symbol=&from=&to=&limit=&page= — one row per
 *    individual analyst rating. `from`/`to` are the ONLY date params honored
 *    (fromDate/toDate are silently ignored). `limit=10000` returns full
 *    history (~3.3yr, floor 2023-06-01) in one call; `page` (0-based) walks
 *    newest-first windows when a symbol exceeds the limit.
 *  - /stable/tipranks-analysts?analystName= — exact-name directory lookup.
 *  - All tipranks-* endpoints return HTTP 402 when the add-on is not active;
 *    fmpGetJson surfaces that as FmpEntitlementError (never retried).
 */
import { fmpGetJson, isoDate, num, str } from "./fmp-client";
import type {
  FmpTipRanksAnalystRaw,
  FmpTipRanksRatingRaw,
  NormalizedTipRanksAnalyst,
  NormalizedTipRanksRating,
} from "./types";

/** Full-history single-call ceiling; a response of exactly this size is treated as possibly truncated. */
export const TIPRANKS_FULL_HISTORY_LIMIT = 10_000;

export interface TipRanksSearchParams {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
  limit?: number;
  page?: number;
}

/** Pure: raw search row -> normalized rating (null when the row has no usable date). */
export function normalizeTipRanksRating(
  symbol: string,
  r: FmpTipRanksRatingRaw,
): NormalizedTipRanksRating | null {
  const ratingDate = isoDate(r.recommendationDate) ?? isoDate(r.date);
  if (!ratingDate) return null;
  return {
    ticker: (str(r.symbol) ?? symbol).toUpperCase(),
    ratingDate,
    publishedAt: str(r.date),
    expertUID: str(r.expertUID),
    analystName: str(r.analystName),
    firmName: str(r.firmName),
    recommendation: str(r.recommendation)?.toLowerCase() ?? null,
    analystAction: str(r.analystAction)?.toLowerCase() ?? null,
    priceTarget: num(r.priceTarget),
    priceTargetCurrency: str(r.priceTargetCurrency),
    articleTitle: str(r.articleTitle),
    articleSite: str(r.articleSite),
    url: str(r.url),
    raw: r,
  };
}

/** Event-level analyst ratings for one symbol (newest first from the API; returned unsorted). */
export async function fetchTipRanksRatings(
  symbol: string,
  params: TipRanksSearchParams = {},
): Promise<NormalizedTipRanksRating[]> {
  const rows = await fmpGetJson<FmpTipRanksRatingRaw[]>("/stable/tipranks-search", {
    symbol,
    from: params.from,
    to: params.to,
    limit: params.limit ?? TIPRANKS_FULL_HISTORY_LIMIT,
    page: params.page,
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => normalizeTipRanksRating(symbol, r))
    .filter((r): r is NormalizedTipRanksRating => r !== null);
}

/** Pure: raw directory row -> normalized analyst (null without an expertUID). */
export function normalizeTipRanksAnalyst(r: FmpTipRanksAnalystRaw): NormalizedTipRanksAnalyst | null {
  const expertUID = str(r.expertUID);
  if (!expertUID) return null;
  return {
    expertUID,
    analystName: str(r.analystName),
    firmName: str(r.firmName),
    successRate: num(r.successRate),
    excessReturn: num(r.excessReturn),
    totalRecommendations: num(r.totalRecommendations),
    goodRecommendations: num(r.goodRecommendations),
    analystRank: num(r.analystRank),
    numOfStars: num(r.numOfStars),
    raw: r,
  };
}

/** Directory lookup by EXACT analyst name (no fuzzy matching on the API side). */
export async function fetchTipRanksAnalyst(analystName: string): Promise<NormalizedTipRanksAnalyst[]> {
  const rows = await fmpGetJson<FmpTipRanksAnalystRaw[]>("/stable/tipranks-analysts", { analystName });
  if (!Array.isArray(rows)) return [];
  return rows
    .map(normalizeTipRanksAnalyst)
    .filter((r): r is NormalizedTipRanksAnalyst => r !== null);
}
