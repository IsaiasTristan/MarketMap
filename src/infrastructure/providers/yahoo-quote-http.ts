import { toYahooSymbol } from "@/infrastructure/providers/yahoo-chart-http";

/**
 * Lightweight Yahoo quote endpoint (no yahoo-finance2 dependency).
 *
 * Quote metadata is non-critical (we fall back to the ticker if it fails), so
 * we don't retry here — keeping the request budget for the chart endpoint.
 */
export async function fetchYahooDisplayName(ticker: string): Promise<string> {
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "MarketMap/1.0 (+https://localhost)",
        Accept: "application/json",
      },
    });
  } catch {
    return ticker.trim().toUpperCase();
  }
  if (!res.ok) return ticker.trim().toUpperCase();
  const j = (await res.json()) as {
    quoteResponse?: {
      result?: {
        longName?: string;
        shortName?: string;
        symbol?: string;
      }[];
    };
  };
  const r = j.quoteResponse?.result?.[0];
  return (
    r?.longName ?? r?.shortName ?? r?.symbol ?? ticker.trim().toUpperCase()
  );
}
