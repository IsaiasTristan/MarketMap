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

/**
 * Try to discover a successor ticker for a delisted symbol. Yahoo doesn't
 * publish a single canonical "successor" field, so we probe a few signals:
 *  1. `quoteSummary` summaryDetail / quoteType — sometimes returns a redirected
 *     symbol when the user looks up an acquired ticker.
 *  2. Yahoo search endpoint — top quote result frequently surfaces the
 *     surviving entity (e.g. searching "JNPR" returns HPE under news) but is
 *     noisy; we only accept a result whose `quoteType === "EQUITY"` and whose
 *     symbol differs from the input.
 *
 * Best-effort and non-blocking — returns null on any failure or ambiguity.
 */
export async function fetchYahooSuccessor(
  ticker: string
): Promise<{ symbol: string; name: string } | null> {
  const upper = ticker.trim().toUpperCase();

  // Probe 1: quoteSummary. Yahoo's summary endpoint occasionally returns a
  // `underlyingSymbol` or redirected `symbol` for delisted/merged equities.
  try {
    const sym = encodeURIComponent(toYahooSymbol(upper));
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=quoteType,summaryDetail,price`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "MarketMap/1.0 (+https://localhost)",
        Accept: "application/json",
      },
    });
    if (res.ok) {
      const j = (await res.json()) as {
        quoteSummary?: {
          result?: {
            quoteType?: { symbol?: string; underlyingSymbol?: string };
            price?: { symbol?: string; longName?: string; shortName?: string };
          }[];
        };
      };
      const r0 = j.quoteSummary?.result?.[0];
      const candidate =
        r0?.quoteType?.underlyingSymbol ??
        (r0?.quoteType?.symbol && r0.quoteType.symbol !== upper
          ? r0.quoteType.symbol
          : undefined) ??
        (r0?.price?.symbol && r0.price.symbol !== upper
          ? r0.price.symbol
          : undefined);
      if (candidate && candidate !== upper) {
        const name =
          r0?.price?.longName ?? r0?.price?.shortName ?? candidate;
        return { symbol: candidate.toUpperCase(), name };
      }
    }
  } catch {
    // fall through to search
  }

  // Probe 2: search. We bias toward EQUITY hits whose symbol differs from
  // the input — typical for renames where Yahoo still surfaces the new
  // listing under the old query.
  try {
    const q = encodeURIComponent(upper);
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=4&newsCount=0`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "MarketMap/1.0 (+https://localhost)",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      quotes?: {
        symbol?: string;
        shortname?: string;
        longname?: string;
        quoteType?: string;
        exchDisp?: string;
      }[];
    };
    const hits = (j.quotes ?? []).filter(
      (q) =>
        q.quoteType === "EQUITY" &&
        q.symbol &&
        q.symbol.toUpperCase() !== upper &&
        // Skip foreign listings (Yahoo prefixes with exchange suffix);
        // surviving US symbols are what's useful here.
        !/\.[A-Z]{1,3}$/.test(q.symbol)
    );
    const top = hits[0];
    if (top?.symbol) {
      return {
        symbol: top.symbol.toUpperCase(),
        name: top.longname ?? top.shortname ?? top.symbol,
      };
    }
  } catch {
    return null;
  }
  return null;
}
