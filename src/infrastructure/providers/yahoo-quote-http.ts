/**
 * Lightweight Yahoo quote endpoint (no yahoo-finance2 dependency).
 */
export async function fetchYahooDisplayName(ticker: string): Promise<string> {
  const sym = encodeURIComponent(ticker.trim().toUpperCase());
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "MarketMap/1.0 (+https://localhost)",
      Accept: "application/json",
    },
  });
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
