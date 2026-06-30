/**
 * Stock news (/stable/news/stock). Returns articles tagged to the requested
 * symbols, used by the portfolio news feed. No DB access - pure I/O; defensive
 * parsing at the boundary (every field on the raw row is optional).
 */
import { fmpGetJson, str } from "./fmp-client";
import type { FmpPressReleaseRaw, FmpStockNewsRaw, NormalizedStockNews } from "./types";

function normalizeRows(rows: unknown): NormalizedStockNews[] {
  if (!Array.isArray(rows)) return [];
  return (rows as FmpStockNewsRaw[])
    .map((r): NormalizedStockNews | null => {
      const ticker = str(r.symbol);
      const title = str(r.title);
      const url = str(r.url);
      const publishedDate = str(r.publishedDate);
      if (!ticker || !title || !url || !publishedDate) return null;
      return {
        ticker: ticker.toUpperCase(),
        publishedDate,
        title,
        text: str(r.text),
        url,
        site: str(r.site),
        publisher: str(r.publisher),
      };
    })
    .filter((r): r is NormalizedStockNews => r !== null);
}

/**
 * Fetch news for one or more symbols. `symbols` is passed comma-separated; FMP
 * returns a mixed array of articles each tagged with its own `symbol`.
 */
export async function fetchStockNews(
  symbols: string[],
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<NormalizedStockNews[]> {
  if (symbols.length === 0) return [];
  const rows = await fmpGetJson<FmpStockNewsRaw[]>("/stable/news/stock", {
    symbols: symbols.join(","),
    from: opts.from,
    to: opts.to,
    limit: opts.limit ?? 100,
  });
  return normalizeRows(rows);
}

/**
 * Fetch official company press releases for one or more symbols
 * (/stable/news/press-releases). Same shape as stock news; these are issued by
 * the company itself, so they are the highest-signal source.
 */
export async function fetchStockPressReleases(
  symbols: string[],
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<NormalizedStockNews[]> {
  if (symbols.length === 0) return [];
  const rows = await fmpGetJson<FmpPressReleaseRaw[]>("/stable/news/press-releases", {
    symbols: symbols.join(","),
    from: opts.from,
    to: opts.to,
    limit: opts.limit ?? 100,
  });
  return normalizeRows(rows);
}
