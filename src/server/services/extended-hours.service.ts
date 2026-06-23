/**
 * Extended-hours quote snapshot + sweep.
 *
 * Maintains an in-memory cache of the latest pre-market / after-hours print
 * for every active universe ticker. The market-map API reads this cache to
 * overlay extended-hours prices onto the regular-close daily series WITHOUT
 * persisting anything to PriceHistory (which is the EOD adjClose tape and
 * must stay clean).
 */
import type { PrismaClient } from "@prisma/client";
import type { MarketSession } from "@/lib/market-map/market-session";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import { fetchYahooExtendedQuotes } from "@/infrastructure/providers/yahoo-chart-http";

/** Per-ticker extended-hours quote stored in the snapshot. */
export type ExtendedTickerQuote = {
  price: number;
  session: "PRE" | "POST";
  asOfUnix: number;
  /** yyyy-MM-dd in America/New_York for the bar's timestamp. */
  tradeDateEt: string;
  /** Today's regular-session close when session=POST (4pm print). */
  regularClose: number | null;
};

/**
 * In-memory snapshot of the most recent extended-hours sweep.
 */
export interface ExtendedSnapshot {
  session: MarketSession | null;
  asOf: string | null;
  quotes: Map<string, ExtendedTickerQuote>;
}

function emptySnapshot(): ExtendedSnapshot {
  return {
    session: null,
    asOf: null,
    quotes: new Map(),
  };
}

const globalForExt = globalThis as unknown as {
  __extendedHoursSnapshot?: ExtendedSnapshot;
};
if (!globalForExt.__extendedHoursSnapshot) {
  globalForExt.__extendedHoursSnapshot = emptySnapshot();
}

/** Read-only accessor — returns the most recent snapshot. */
export function getExtendedSnapshot(): ExtendedSnapshot {
  const snap = globalForExt.__extendedHoursSnapshot!;
  // Hot-reload / schema migration: prior builds stored `prices` only.
  // Drop the stale shape so the runner's next BACKFILL repopulates quotes.
  if (!snap.quotes) {
    globalForExt.__extendedHoursSnapshot = emptySnapshot();
    return globalForExt.__extendedHoursSnapshot!;
  }
  return snap;
}

/** Wipe the cache. Called by the runner when leaving an extended window. */
export function clearExtendedSnapshot(): void {
  globalForExt.__extendedHoursSnapshot = emptySnapshot();
}

export interface SweepResult {
  ticker: string;
  price: number;
  session: "PRE" | "POST";
}

export interface SweepSummary {
  attempted: number;
  applied: number;
  results: SweepResult[];
}

export async function sweepExtendedHours(
  db: PrismaClient,
  mode: "PRE" | "POST" | "BACKFILL",
): Promise<SweepSummary> {
  const constituents = await db.universeConstituent.findMany({
    where: { security: { isActive: true } },
    select: { security: { select: { ticker: true } } },
  });
  const tickers = Array.from(
    new Set(constituents.map((c) => c.security.ticker)),
  );

  const snapshotSession: "PRE" | "POST" = mode === "PRE" ? "PRE" : "POST";

  if (tickers.length === 0) {
    globalForExt.__extendedHoursSnapshot = {
      session: snapshotSession,
      asOf: new Date().toISOString(),
      quotes: new Map(),
    };
    return { attempted: 0, applied: 0, results: [] };
  }

  const range = mode === "BACKFILL" ? "5d" : "1d";
  const yahooQuotes = await fetchYahooExtendedQuotes(tickers, { range });
  const quotes = new Map<string, ExtendedTickerQuote>();
  const results: SweepResult[] = [];
  let latestBarUnix = 0;

  for (const [ticker, q] of yahooQuotes) {
    if (q.session !== "PRE" && q.session !== "POST") continue;
    const tradeDateEt = tradeDateEtFromUnix(q.asOfUnix);
    quotes.set(ticker, {
      price: q.price,
      session: q.session,
      asOfUnix: q.asOfUnix,
      tradeDateEt,
      regularClose: q.regularClose,
    });
    results.push({ ticker, price: q.price, session: q.session });
    if (q.asOfUnix > latestBarUnix) latestBarUnix = q.asOfUnix;
  }

  const asOf =
    mode === "BACKFILL" && latestBarUnix > 0
      ? new Date(latestBarUnix * 1000).toISOString()
      : new Date().toISOString();

  globalForExt.__extendedHoursSnapshot = {
    session: snapshotSession,
    asOf,
    quotes,
  };

  return { attempted: tickers.length, applied: quotes.size, results };
}
