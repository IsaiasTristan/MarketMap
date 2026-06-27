/**
 * Live regular-session quote snapshot + sweep.
 *
 * Maintains an in-memory cache of the latest regular-session print for every
 * active universe ticker during REGULAR hours. The market-map REGULAR-hours
 * runner reads this cache to overlay today's intraday move onto the
 * precomputed grid WITHOUT persisting anything to PriceHistory (which is the
 * EOD adjClose tape and must stay clean).
 *
 * Mirrors `extended-hours.service.ts` but for the regular session, and uses
 * the bulk `spark` provider (one request per ~50 tickers) instead of one
 * chart request per ticker, so a full sweep of ~2000 tickers stays well
 * inside the 60s cadence.
 *
 * The snapshot is hoisted onto `globalThis` (same pattern as the extended-
 * hours snapshot + the Prisma client) so the runner that writes it and any
 * reader share one instance across Next.js dev server bundles. This is a
 * per-process cache — valid for the single 24/7 desktop deployment; a
 * multi-instance deployment would need a shared store (see AGENTS.md).
 */
import type { PrismaClient } from "@prisma/client";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import {
  fetchYahooBulkQuotes,
  type ServedVia,
} from "@/infrastructure/providers/yahoo-bulk-quote";

/** Per-ticker live quote stored in the snapshot. */
export interface LiveRegularQuote {
  price: number;
  prevClose: number;
  asOfUnix: number;
  /** yyyy-MM-dd in America/New_York for the bar's timestamp. */
  tradeDateEt: string;
}

export interface LiveRegularSnapshot {
  asOf: string | null;
  servedVia: ServedVia | null;
  quotes: Map<string, LiveRegularQuote>;
}

function emptySnapshot(): LiveRegularSnapshot {
  return { asOf: null, servedVia: null, quotes: new Map() };
}

const globalForLive = globalThis as unknown as {
  __liveRegularSnapshot?: LiveRegularSnapshot;
};
if (!globalForLive.__liveRegularSnapshot) {
  globalForLive.__liveRegularSnapshot = emptySnapshot();
}

/** Read-only accessor — returns the most recent snapshot. */
export function getLiveRegularSnapshot(): LiveRegularSnapshot {
  const snap = globalForLive.__liveRegularSnapshot!;
  if (!snap.quotes) {
    globalForLive.__liveRegularSnapshot = emptySnapshot();
    return globalForLive.__liveRegularSnapshot!;
  }
  return snap;
}

/** Wipe the cache. Not used by the runner (which freezes rather than clears),
 *  but exposed for completeness / tests. */
export function clearLiveRegularSnapshot(): void {
  globalForLive.__liveRegularSnapshot = emptySnapshot();
}

export interface LiveRegularSweepSummary {
  attempted: number;
  applied: number;
  servedVia: ServedVia | null;
  failed: number;
}

/**
 * Sweep live quotes for every active universe ticker and store them in the
 * snapshot. Overwrites the snapshot wholesale so yesterday's frozen prices can
 * never bleed into today. Returns a small summary for runner logging.
 */
export async function sweepRegularQuotes(
  db: PrismaClient,
): Promise<LiveRegularSweepSummary> {
  const constituents = await db.universeConstituent.findMany({
    where: { security: { isActive: true } },
    select: { security: { select: { ticker: true } } },
  });
  const tickers = Array.from(
    new Set(constituents.map((c) => c.security.ticker)),
  );

  if (tickers.length === 0) {
    globalForLive.__liveRegularSnapshot = {
      asOf: new Date().toISOString(),
      servedVia: null,
      quotes: new Map(),
    };
    return { attempted: 0, applied: 0, servedVia: null, failed: 0 };
  }

  const { quotes: bulk, servedVia, failed } =
    await fetchYahooBulkQuotes(tickers);

  const quotes = new Map<string, LiveRegularQuote>();
  for (const [ticker, q] of bulk) {
    quotes.set(ticker, {
      price: q.price,
      prevClose: q.prevClose,
      asOfUnix: q.asOfUnix,
      tradeDateEt: tradeDateEtFromUnix(q.asOfUnix),
    });
  }

  globalForLive.__liveRegularSnapshot = {
    asOf: new Date().toISOString(),
    servedVia,
    quotes,
  };

  return {
    attempted: tickers.length,
    applied: quotes.size,
    servedVia,
    failed: failed.length,
  };
}
