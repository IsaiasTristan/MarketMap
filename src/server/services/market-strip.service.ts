/**
 * Market ticker strip — live snapshot of headline market instruments shown
 * under the global TopBar.
 *
 * Pulls quotes (plus today's 5-minute intraday close series for the chip
 * sparkline) from Yahoo's v8 chart endpoint via
 * `fetchYahooQuotesWithSparkline` (the v7 quote endpoint requires a session
 * crumb and returns HTTP 401 to anonymous traffic). Instruments are
 * intentionally heterogeneous (equity indices, VIX, commodities futures,
 * crypto, FX, and Treasury yields). The `=F` continuous front-month series
 * for crude (CL=F) and natural gas (NG=F) are auto-rolling on Yahoo's side,
 * so the strip never has to track expiries manually.
 *
 * For yields (^FVX, ^TNX) Yahoo returns the yield level as the quote price
 * (e.g. 4.25 for 4.25%). The `kind: "yield"` branch surfaces the day-over-day
 * change in basis points (1 yield-point = 100 bp).
 */
import {
  fetchYahooQuotesWithSparkline,
  toYahooSymbol,
} from "@/infrastructure/providers/yahoo-chart-http";

export type StripInstrumentKind = "price" | "yield";

export interface StripInstrument {
  label: string;
  yahooSymbol: string;
  kind: StripInstrumentKind;
  decimals: number;
}

export interface MarketStripQuote {
  label: string;
  symbol: string;
  kind: StripInstrumentKind;
  decimals: number;
  price: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** Only populated when `kind === "yield"`; 1 yield-point == 100 bp. */
  changeBp: number | null;
  /** Today's intraday close series (oldest -> newest) for the chip sparkline.
   *  Empty when no intraday data is available — chip renders just a baseline. */
  sparkline: number[];
}

/**
 * Order matters — this is the left-to-right display order in the UI strip.
 */
export const STRIP_INSTRUMENTS: readonly StripInstrument[] = [
  { label: "S&P 500", yahooSymbol: "^GSPC", kind: "price", decimals: 2 },
  { label: "DOW", yahooSymbol: "^DJI", kind: "price", decimals: 2 },
  { label: "NASDAQ", yahooSymbol: "^IXIC", kind: "price", decimals: 2 },
  { label: "VIX", yahooSymbol: "^VIX", kind: "price", decimals: 2 },
  { label: "Gold", yahooSymbol: "GC=F", kind: "price", decimals: 2 },
  { label: "Bitcoin", yahooSymbol: "BTC-USD", kind: "price", decimals: 0 },
  { label: "WTI", yahooSymbol: "CL=F", kind: "price", decimals: 2 },
  { label: "HHUB", yahooSymbol: "NG=F", kind: "price", decimals: 3 },
  { label: "EUR/USD", yahooSymbol: "EURUSD=X", kind: "price", decimals: 4 },
  { label: "USD/JPY", yahooSymbol: "USDJPY=X", kind: "price", decimals: 2 },
  { label: "5Y", yahooSymbol: "^FVX", kind: "yield", decimals: 2 },
  { label: "10Y", yahooSymbol: "^TNX", kind: "yield", decimals: 2 },
] as const;

/**
 * Pure helper — derive change / changePct / changeBp from a price snapshot.
 * Exposed for unit testing. Returns nulls when inputs are unusable so the UI
 * can render a dash without branching on every field.
 */
export function computeStripQuote(
  price: number | null | undefined,
  prevClose: number | null | undefined,
  kind: StripInstrumentKind,
): {
  change: number | null;
  changePct: number | null;
  changeBp: number | null;
} {
  if (price == null || !Number.isFinite(price)) {
    return { change: null, changePct: null, changeBp: null };
  }
  if (prevClose == null || !Number.isFinite(prevClose)) {
    return { change: null, changePct: null, changeBp: null };
  }
  const change = price - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose : null;
  const changeBp = kind === "yield" ? change * 100 : null;
  return { change, changePct, changeBp };
}

export async function getMarketStrip(): Promise<MarketStripQuote[]> {
  const yahooSymbols = STRIP_INSTRUMENTS.map((i) => i.yahooSymbol);
  const quotes = await fetchYahooQuotesWithSparkline(yahooSymbols);

  return STRIP_INSTRUMENTS.map((inst) => {
    // The fetcher keys its result by the Yahoo-normalised symbol, so we
    // re-normalise our input symbol to look it up safely (no-op for the
    // strip's symbols today, but keeps the contract aligned with the
    // upstream Map).
    const key = toYahooSymbol(inst.yahooSymbol);
    const q = quotes.get(key);
    const price = q?.price ?? null;
    const prevClose = q?.prevClose ?? null;
    const derived = computeStripQuote(price, prevClose, inst.kind);
    return {
      label: inst.label,
      symbol: inst.yahooSymbol,
      kind: inst.kind,
      decimals: inst.decimals,
      price,
      prevClose,
      ...derived,
      sparkline: q?.intradayCloses ?? [],
    };
  });
}
