/**
 * Pure ranking for the portfolio news feed. No I/O. Takes raw per-ticker
 * articles (already fetched from FMP) plus a ticker -> company-name map and
 * produces the display rows: deduped, spread across holdings (so one noisy name
 * cannot dominate), then ordered newest-first and capped.
 */

/** A news article tagged to one ticker (subset of NormalizedStockNews). */
export interface NewsArticle {
  ticker: string;
  publishedDate: string;
  title: string;
  text: string | null;
  url: string;
  site: string | null;
  publisher: string | null;
  /** True when sourced from the company-issued press-release feed. */
  isPressRelease: boolean;
}

/** A display-ready news row with the resolved company name attached. */
export interface PortfolioNewsRow {
  ticker: string;
  companyName: string;
  title: string;
  preview: string;
  url: string;
  publishedDate: string;
  site: string | null;
  publisher: string | null;
  isPressRelease: boolean;
}

export interface RankNewsOptions {
  /** Max rows returned overall. */
  limit: number;
  /** Max rows kept per ticker before the global cap. */
  perTickerCap: number;
}

function publishedMs(a: { publishedDate: string }): number {
  const t = new Date(a.publishedDate).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Press releases first, then newest-first. */
function byPriority(x: NewsArticle, y: NewsArticle): number {
  if (x.isPressRelease !== y.isPressRelease) return x.isPressRelease ? -1 : 1;
  return publishedMs(y) - publishedMs(x);
}

/**
 * Rank portfolio news into display rows.
 *
 * Steps: drop articles for tickers not held; dedupe by URL (keeping the newest
 * occurrence); per ticker keep the `perTickerCap` highest-priority (press
 * releases first, then newest); round-robin merge across tickers (each ticker
 * contributes its top unused article each pass) so coverage is spread; take the
 * first `limit` from that round-robin order (this is what enforces the spread
 * when over the cap); finally sort the surviving rows press-releases-first,
 * then newest, for display.
 */
export function rankPortfolioNews(
  articles: NewsArticle[],
  nameByTicker: Map<string, string>,
  opts: RankNewsOptions,
): PortfolioNewsRow[] {
  const held = nameByTicker;

  // Dedupe by URL, keeping the newest occurrence.
  const byUrl = new Map<string, NewsArticle>();
  for (const a of articles) {
    const ticker = a.ticker.toUpperCase();
    if (!held.has(ticker)) continue;
    const key = a.url.trim().toLowerCase();
    if (!key) continue;
    const existing = byUrl.get(key);
    if (!existing || publishedMs(a) > publishedMs(existing)) {
      byUrl.set(key, { ...a, ticker });
    }
  }

  // Group by ticker, newest-first, capped per ticker.
  const byTicker = new Map<string, NewsArticle[]>();
  for (const a of byUrl.values()) {
    const list = byTicker.get(a.ticker) ?? [];
    list.push(a);
    byTicker.set(a.ticker, list);
  }
  for (const list of byTicker.values()) {
    list.sort(byPriority);
    if (list.length > opts.perTickerCap) list.length = opts.perTickerCap;
  }

  // Round-robin merge across tickers (sorted by ticker for stable order).
  const tickers = [...byTicker.keys()].sort();
  const merged: NewsArticle[] = [];
  let pass = 0;
  let added = true;
  while (added) {
    added = false;
    for (const t of tickers) {
      const list = byTicker.get(t)!;
      if (pass < list.length) {
        merged.push(list[pass]!);
        added = true;
      }
    }
    pass++;
  }

  // Take the first `limit` in round-robin order (enforces spread when over the
  // cap), then sort the survivors press-releases-first, then newest, for display.
  const capped = merged.slice(0, Math.max(0, opts.limit));
  capped.sort(byPriority);

  return capped.map((a) => ({
    ticker: a.ticker,
    companyName: held.get(a.ticker) ?? a.ticker,
    title: a.title,
    preview: a.text ?? "",
    url: a.url,
    publishedDate: a.publishedDate,
    site: a.site,
    publisher: a.publisher,
    isPressRelease: a.isPressRelease,
  }));
}
