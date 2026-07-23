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
import { getUsMarketSession } from "@/lib/market-map/market-session";
import type { SparklineTimeMode } from "@/lib/market/sparkline-session-layout";

export type StripInstrumentKind = "price" | "yield";

export type StripPrevCloseMode = "regular" | "settlement";

export interface StripInstrument {
  label: string;
  yahooSymbol: string;
  kind: StripInstrumentKind;
  decimals: number;
  timeMode: SparklineTimeMode;
  /** CBOE indices (VIX) settle ~16:10 ET — use bar-derived close, not Yahoo meta. */
  prevCloseMode?: StripPrevCloseMode;
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
  /** Prior trading session closes for the seam sparkline left segment. */
  prevDaySparkline: number[];
  /** Today's PRE/POST extended-hours closes for the dashed gray tail. */
  extendedSparkline: number[];
  timeMode: SparklineTimeMode;
}

/**
 * Order matters — this is the left-to-right display order in the UI strip.
 */
export const STRIP_INSTRUMENTS: readonly StripInstrument[] = [
  { label: "S&P 500", yahooSymbol: "^GSPC", kind: "price", decimals: 2, timeMode: "us_regular" },
  { label: "DOW", yahooSymbol: "^DJI", kind: "price", decimals: 2, timeMode: "us_regular" },
  { label: "NASDAQ", yahooSymbol: "^IXIC", kind: "price", decimals: 2, timeMode: "us_regular" },
  { label: "VIX", yahooSymbol: "^VIX", kind: "price", decimals: 2, timeMode: "us_regular", prevCloseMode: "settlement" },
  { label: "Gold", yahooSymbol: "GC=F", kind: "price", decimals: 2, timeMode: "et_calendar_day" },
  { label: "Bitcoin", yahooSymbol: "BTC-USD", kind: "price", decimals: 0, timeMode: "et_calendar_day" },
  { label: "WTI", yahooSymbol: "CL=F", kind: "price", decimals: 2, timeMode: "et_calendar_day" },
  { label: "HHUB", yahooSymbol: "NG=F", kind: "price", decimals: 3, timeMode: "et_calendar_day" },
  { label: "EUR/USD", yahooSymbol: "EURUSD=X", kind: "price", decimals: 4, timeMode: "et_calendar_day" },
  { label: "USD/JPY", yahooSymbol: "USDJPY=X", kind: "price", decimals: 2, timeMode: "et_calendar_day" },
  { label: "5Y", yahooSymbol: "^FVX", kind: "yield", decimals: 2, timeMode: "us_regular" },
  { label: "10Y", yahooSymbol: "^TNX", kind: "yield", decimals: 2, timeMode: "us_regular" },
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
  const settlementSymbols = new Set(
    STRIP_INSTRUMENTS.filter((i) => i.prevCloseMode === "settlement").map((i) =>
      toYahooSymbol(i.yahooSymbol),
    ),
  );
  const quotes = await fetchYahooQuotesWithSparkline(yahooSymbols, {
    settlementSymbols,
  });

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
      prevDaySparkline: q?.prevDayCloses ?? [],
      extendedSparkline: q?.extendedCloses ?? [],
      timeMode: inst.timeMode,
    };
  });
}

// ── Server-side stale-while-revalidate cache ───────────────────────────────
//
// The strip's 12 macro instruments are NOT part of the universe sweep, so they
// have no background snapshot to read from. Instead of fetching live Yahoo on
// every request (which stalls the strip for minutes when Yahoo throttles the
// prod IP), wrap `getMarketStrip()` in a shared cache that:
//   • returns the cached value immediately — even when stale — so a request
//     never blocks on live Yahoo after the first successful fill;
//   • refreshes in the background under a single-flight guard (concurrent
//     requests share one in-flight fetch);
//   • serves the LAST GOOD value on a throttle/empty response, so the strip
//     never reverts to "Loading market data…" once populated.
// globalThis-singleton so Next.js dev's separate route bundles share one cache
// (same pattern as the Prisma client / the factor-top-movers cache).

const STRIP_TTL_REGULAR_MS = 30_000;
const STRIP_TTL_OFFHOURS_MS = 5 * 60_000;
/** Floor between refresh attempts so a fast-failing fetch can't hot-loop. */
const STRIP_REFRESH_MIN_GAP_MS = 5_000;

interface StripCacheState {
  entry: { at: number; quotes: MarketStripQuote[] } | null;
  inflight: Promise<void> | null;
  lastTryAt: number;
}

const globalForStrip = globalThis as unknown as {
  __marketStripCache?: StripCacheState;
};
const stripCache: StripCacheState =
  globalForStrip.__marketStripCache ?? {
    entry: null,
    inflight: null,
    lastTryAt: 0,
  };
if (process.env.NODE_ENV !== "production") {
  globalForStrip.__marketStripCache = stripCache;
}

/** Reset the strip cache. Test-only hook. */
export function _resetMarketStripCache(): void {
  stripCache.entry = null;
  stripCache.inflight = null;
  stripCache.lastTryAt = 0;
}

function startStripRefresh(): Promise<void> {
  if (stripCache.inflight) return stripCache.inflight;
  stripCache.lastTryAt = Date.now();
  const run = (async () => {
    try {
      const quotes = await getMarketStrip();
      // Only overwrite on a usable response — a throttled fetch that yields all
      // null prices must not clobber the last good values (serve-stale).
      if (quotes.some((q) => q.price != null)) {
        stripCache.entry = { at: Date.now(), quotes };
      }
    } catch {
      // Keep the last good value; the next poll retries.
    } finally {
      stripCache.inflight = null;
    }
  })();
  stripCache.inflight = run;
  return run;
}

/**
 * Stale-while-revalidate accessor used by the `/api/market/strip` route.
 * Never blocks on live Yahoo once the cache has been filled once.
 */
export async function getMarketStripCached(): Promise<MarketStripQuote[]> {
  const now = Date.now();
  const ttl =
    getUsMarketSession(new Date()) === "REGULAR"
      ? STRIP_TTL_REGULAR_MS
      : STRIP_TTL_OFFHOURS_MS;
  const { entry } = stripCache;
  const fresh = entry && now - entry.at < ttl;

  if (fresh) return entry!.quotes;

  // Stale or cold — kick off a background refresh (throttled + single-flight).
  const shouldTry =
    !stripCache.inflight && now - stripCache.lastTryAt >= STRIP_REFRESH_MIN_GAP_MS;
  const refresh = shouldTry ? startStripRefresh() : stripCache.inflight;

  // Have a (stale) value → serve it immediately without waiting on the refresh.
  if (entry) return entry.quotes;

  // Cold cache: wait on the in-flight fetch so the very first load returns data
  // rather than an empty strip. Bounded by getMarketStrip's own request timeouts.
  if (refresh) await refresh;
  return stripCache.entry?.quotes ?? [];
}
