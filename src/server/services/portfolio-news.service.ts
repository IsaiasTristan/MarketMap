/**
 * portfolio-news.service - real-time news feed for a portfolio's holdings.
 *
 * Loads the active portfolio's holding tickers (+ company names from the DB),
 * fetches recent news for them from FMP (/stable/news/stock) in chunked
 * symbol batches via fmpPool, then ranks the articles into display rows via the
 * pure rankPortfolioNews helper. Holdings-only: no peer-company news.
 *
 * Results are cached on a short TTL (globalThis-singleton Map so Next.js dev's
 * separate route bundles share one instance, same pattern as the Prisma
 * client). News is live read-only; nothing is persisted to the database.
 */
import {
  fetchStockNews,
  fetchStockPressReleases,
  fmpPool,
} from "@/infrastructure/providers/fmp";
import { getPositions } from "./position.service";
import {
  rankPortfolioNews,
  type NewsArticle,
  type PortfolioNewsRow,
} from "@/lib/news/rank-news";
import { filterNewsArticles } from "@/lib/news/filter-news";
import type { NormalizedStockNews } from "@/infrastructure/providers/fmp";

const NEWS_TTL_MS = 5 * 60_000;
const LOOKBACK_DAYS = 21;
const SYMBOLS_PER_CALL = 30;
const PER_CALL_LIMIT = 250;
const PER_TICKER_CAP = 4;
const DEFAULT_LIMIT = 25;

export interface PortfolioNewsResult {
  rows: PortfolioNewsRow[];
  fetchedAt: string;
}

interface NewsCacheEntry {
  at: number;
  result: PortfolioNewsResult;
}

const globalForNews = globalThis as unknown as {
  __portfolioNewsCache?: Map<string, NewsCacheEntry>;
};

const newsCache: Map<string, NewsCacheEntry> =
  globalForNews.__portfolioNewsCache ?? new Map();

if (process.env.NODE_ENV !== "production") {
  globalForNews.__portfolioNewsCache = newsCache;
}

/** Reset the news cache. Test-only / invalidation hook. */
export function _resetPortfolioNewsCache(): void {
  newsCache.clear();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function lookbackFrom(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getPortfolioNews(
  portfolioId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<PortfolioNewsResult> {
  const cacheKey = `${portfolioId}|${limit}`;
  const now = Date.now();
  const hit = newsCache.get(cacheKey);
  if (hit && now - hit.at < NEWS_TTL_MS) return hit.result;

  const positions = await getPositions(portfolioId);
  const nameByTicker = new Map<string, string>();
  for (const p of positions) {
    if (p.isCash || p.ticker === "CASH") continue;
    nameByTicker.set(p.ticker.toUpperCase(), p.name);
  }

  const result: PortfolioNewsResult = {
    rows: [],
    fetchedAt: new Date().toISOString(),
  };

  if (nameByTicker.size === 0) {
    newsCache.set(cacheKey, { at: now, result });
    return result;
  }

  const from = lookbackFrom(LOOKBACK_DAYS);
  const batches = chunk([...nameByTicker.keys()], SYMBOLS_PER_CALL);

  const tag = (rows: NormalizedStockNews[], isPressRelease: boolean): NewsArticle[] =>
    rows.map((r) => ({ ...r, isPressRelease }));

  const { results } = await fmpPool(
    batches,
    async (symbols): Promise<NewsArticle[]> => {
      const [pressReleases, news] = await Promise.all([
        fetchStockPressReleases(symbols, { from, limit: PER_CALL_LIMIT }).catch(() => []),
        fetchStockNews(symbols, { from, limit: PER_CALL_LIMIT }),
      ]);
      return [...tag(pressReleases, true), ...tag(news, false)];
    },
    { concurrency: 4 },
  );

  const articles: NewsArticle[] = filterNewsArticles(
    results.flatMap((r) => r.value),
    nameByTicker,
  );
  result.rows = rankPortfolioNews(articles, nameByTicker, {
    limit,
    perTickerCap: PER_TICKER_CAP,
  });

  newsCache.set(cacheKey, { at: now, result });
  return result;
}
