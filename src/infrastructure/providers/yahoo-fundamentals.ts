/**
 * Yahoo Finance fundamentals + asset profile via the v10 quoteSummary endpoint.
 * All fields are optional — missing/unavailable fields return null.
 */

import { toYahooSymbol } from "./yahoo-chart-http";

export interface YahooFundamentals {
  ticker: string;
  name?: string;
  sector?: string;
  country?: string;
  currency?: string;
  // Valuation
  marketCap?: number;
  bookToPrice?: number;   // inverse of P/B
  earningsToPrice?: number; // inverse of trailing P/E
  fcfYield?: number;
  // Quality
  roe?: number;
  grossMargin?: number;
  debtToEquity?: number;
  // Momentum / crowding
  shortRatio?: number;
  // Prices for liquidity calc
  avgVolume20d?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchYahooFundamentals(
  ticker: string,
): Promise<YahooFundamentals> {
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const modules = [
    "assetProfile",
    "defaultKeyStatistics",
    "financialData",
    "summaryDetail",
  ].join(",");
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules}`;

  let res: Response | undefined;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "MarketMap/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      await sleep(300 * attempt);
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(500 * attempt);
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    return { ticker };
  }

  const json = await res.json().catch(() => null);
  const result = json?.quoteSummary?.result?.[0];
  if (!result) return { ticker };

  const profile = result.assetProfile ?? {};
  const stats = result.defaultKeyStatistics ?? {};
  const financial = result.financialData ?? {};
  const summary = result.summaryDetail ?? {};

  const raw = (obj: Record<string, unknown>, key: string): number | undefined => {
    const v = (obj[key] as { raw?: number } | undefined)?.raw;
    return typeof v === "number" && isFinite(v) ? v : undefined;
  };

  const mktCap = raw(summary, "marketCap");
  const trailingPE = raw(summary, "trailingPE");
  const pbRatio = raw(stats, "priceToBook");
  const freeCashflow = raw(financial, "freeCashflow");
  const roe = raw(financial, "returnOnEquity");
  const grossMargins = raw(financial, "grossMargins");
  const debtToEquity = raw(financial, "debtToEquity");
  const shortRatio = raw(stats, "shortRatio");
  const avgVolume = raw(summary, "averageVolume");

  return {
    ticker,
    name: profile.longName || profile.shortName,
    sector: profile.sector,
    country: profile.country,
    currency: summary.currency as string | undefined,
    marketCap: mktCap,
    bookToPrice: pbRatio != null ? 1 / pbRatio : undefined,
    earningsToPrice: trailingPE != null ? 1 / trailingPE : undefined,
    fcfYield:
      freeCashflow != null && mktCap ? freeCashflow / mktCap : undefined,
    roe,
    grossMargin: grossMargins,
    debtToEquity,
    shortRatio,
    avgVolume20d: avgVolume,
  };
}

/** Fetch live quote for multiple tickers (price + volume snapshot).
 * @deprecated Yahoo v7 /quote returns HTTP 401 without a session crumb.
 * Use `fetchYahooQuotesViaChart` from `yahoo-chart-http` instead.
 */
export async function fetchYahooQuotes(
  tickers: string[],
): Promise<Map<string, { price: number; volume: number; prevClose: number }>> {
  const syms = tickers.map(toYahooSymbol).join(",");
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketVolume,regularMarketPreviousClose,averageDailyVolume3Month`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MarketMap/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return new Map();
    const json = await res.json();
    const quotes = json?.quoteResponse?.result as Array<{
      symbol: string;
      regularMarketPrice?: number;
      regularMarketVolume?: number;
      regularMarketPreviousClose?: number;
      averageDailyVolume3Month?: number;
    }> ?? [];

    const out = new Map<string, { price: number; volume: number; prevClose: number }>();
    for (const q of quotes) {
      if (q.regularMarketPrice != null) {
        out.set(q.symbol, {
          price: q.regularMarketPrice,
          volume: q.regularMarketVolume ?? 0,
          prevClose: q.regularMarketPreviousClose ?? q.regularMarketPrice,
        });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}
