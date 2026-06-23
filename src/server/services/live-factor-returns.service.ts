/**
 * live-factor-returns.service — fetch today's live MACRO14 factor row.
 *
 * Wraps `composeLiveFactors` with the I/O layer:
 *   1. Batch-fetch live quotes for the ~16 underlying ETFs from Yahoo via
 *      `fetchYahooQuotesWithSparkline`.
 *   2. Read the latest stored RF (daily simple decimal) from FactorReturnDaily
 *      so excess-of-RF legs are consistent with the historical pipeline.
 *   3. Compose the per-factor live 1D return.
 *
 * Available in any session with a usable Yahoo quote — during REGULAR hours
 * `regularMarketPrice` is the live tape; after the close it is today's
 * official 16:00 ET print. Returns null only when Yahoo returns nothing
 * usable (throttle / network / all legs missing); callers fall back to the
 * cached at-close period slice.
 *
 * In-memory cache — ~30s during REGULAR (tape moves), ~5min otherwise (print
 * is static after the close). The popup, per-stock detail, and portfolio
 * attribution route share one fetch per refresh interval.
 */
import { prisma as db } from "@/infrastructure/db/client";
import {
  fetchYahooQuotesWithSparkline,
  toYahooSymbol,
} from "@/infrastructure/providers/yahoo-chart-http";
import {
  getUsMarketSession,
  type MarketSession,
} from "@/lib/market-map/market-session";
import {
  composeLiveFactors,
  LIVE_FACTOR_ETFS,
  type LiveFactorEtf,
  type LiveQuote,
} from "@/lib/factors/live/compose-live-factors";
import type { FactorCode } from "@/types/factors";

/** Cache TTL (ms) during REGULAR — live ETF quotes move every few seconds. */
const CACHE_TTL_REGULAR_MS = 30_000;
/** Cache TTL (ms) outside REGULAR — today's closing print is static. */
const CACHE_TTL_AFTER_CLOSE_MS = 5 * 60_000;

export interface LiveFactorRow {
  /** ISO timestamp the row was composed at. */
  asOf: string;
  /** Per-factor live 1D simple decimal return. Only present factors are populated. */
  returns: Partial<Record<FactorCode, number>>;
  /** Daily simple decimal RF used in the composition (latest stored row). */
  rf: number;
  /** ETFs that were required by at least one factor but had no usable quote. */
  missingLegs: LiveFactorEtf[];
  /** US market session at fetch time (REGULAR, POST, CLOSED, etc.). */
  session: MarketSession;
}

interface CacheEntry {
  at: number;
  row: LiveFactorRow;
}

let cached: CacheEntry | null = null;

/** Reset the cache. Test-only. */
export function _resetLiveFactorReturnsCache(): void {
  cached = null;
}

async function fetchLatestRfDaily(): Promise<number> {
  const row = await db.factorReturnDaily.findFirst({
    where: { factorCode: "RF" },
    orderBy: { tradeDate: "desc" },
    select: { value: true },
  });
  // Same fallback as factor-pipeline-macro.service (4.5%/252 daily).
  return row ? Number(row.value) : 0.045 / 252;
}

/**
 * Fetch live ETF quotes and re-key by the input symbol (since the Yahoo helper
 * keys by its normalised symbol — e.g. "BRK.B" → "BRK-B", which is fine here
 * because every ETF in `LIVE_FACTOR_ETFS` round-trips unchanged through
 * `toYahooSymbol`, but we re-key explicitly so the mapping stays robust if a
 * future override is added to `YAHOO_SYMBOL_OVERRIDES`).
 */
async function fetchLiveEtfQuotes(): Promise<
  Partial<Record<LiveFactorEtf, LiveQuote>>
> {
  const tickers = [...LIVE_FACTOR_ETFS];
  const byYahoo = await fetchYahooQuotesWithSparkline(tickers);
  const out: Partial<Record<LiveFactorEtf, LiveQuote>> = {};
  for (const t of tickers) {
    const q = byYahoo.get(toYahooSymbol(t));
    if (!q) continue;
    out[t] = { price: q.price, prevClose: q.prevClose };
  }
  return out;
}

/**
 * Compose today's live MACRO14 factor row.
 *
 * Returns `null` when no live ETF leg could be fetched at all (Yahoo
 * throttled / network) or every required leg is missing.
 *
 * Partial composition is allowed — individual factors whose legs are missing
 * are absent from `returns`; the caller can show "LIVE (N/14)" diagnostics
 * via the populated `missingLegs` list.
 */
export async function getLiveFactorRow(now: Date = new Date()): Promise<
  LiveFactorRow | null
> {
  const session = getUsMarketSession(now);
  const ttl =
    session === "REGULAR" ? CACHE_TTL_REGULAR_MS : CACHE_TTL_AFTER_CLOSE_MS;

  if (cached && now.getTime() - cached.at < ttl) {
    return cached.row;
  }

  const [quotes, rf] = await Promise.all([
    fetchLiveEtfQuotes(),
    fetchLatestRfDaily(),
  ]);

  // Hard failure: no ETF responded. Treat as "live unavailable" so the caller
  // can fall back rather than emit a row of all-missing factors.
  if (Object.keys(quotes).length === 0) return null;

  const composed = composeLiveFactors({ quotes, rfDaily: rf });
  // Guard against the (extremely unlikely) case where every required leg is
  // missing — composeLiveFactors would emit an empty returns map, which the
  // caller would treat as "no factor decomposition possible".
  if (Object.keys(composed.returns).length === 0) return null;

  const row: LiveFactorRow = {
    asOf: now.toISOString(),
    returns: composed.returns,
    rf: composed.rf,
    missingLegs: composed.missingLegs,
    session,
  };

  cached = { at: now.getTime(), row };
  return row;
}

/**
 * Fetch a live 1D simple return for a single equity ticker. Uses the same
 * Yahoo chart endpoint as `fetchLiveEtfQuotes` but for an arbitrary symbol,
 * so per-stock live 1D decomposition can stack on top of `getLiveFactorRow`.
 *
 * Returns null when the symbol has no usable quote (delisted / throttled /
 * malformed prevClose). Not cached — most callers fetch one ticker at a time
 * and the underlying HTTP helper already retries on 401/429/5xx.
 */
export async function getLiveStockReturn(
  ticker: string,
): Promise<{ price: number; prevClose: number; return1D: number } | null> {
  const byYahoo = await fetchYahooQuotesWithSparkline([ticker]);
  const q = byYahoo.get(toYahooSymbol(ticker));
  if (!q) return null;
  if (
    !Number.isFinite(q.price) ||
    !Number.isFinite(q.prevClose) ||
    q.prevClose <= 0
  ) {
    return null;
  }
  return {
    price: q.price,
    prevClose: q.prevClose,
    return1D: q.price / q.prevClose - 1,
  };
}
