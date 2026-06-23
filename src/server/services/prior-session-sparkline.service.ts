/**
 * Prior-session sparkline cache + sweep.
 *
 * The holdings dashboard's "Previous Price" sparkline is the prior regular
 * trading session's intraday series. That series is IMMUTABLE once the session
 * closes, yet the dashboard refreshes every 20s — so re-pulling it from Yahoo
 * on every refresh is wasted work that contributes to anonymous-endpoint
 * throttling (HTTP 429), which in turn blanks names + charts for a random
 * subset of rows.
 *
 * This service keeps an in-memory snapshot of every active universe ticker's
 * prior-session sparkline, populated once per trading day by a server-side
 * sweep (see prior-session-runner). The holdings service reads from here
 * instead of pulling the prior session live.
 *
 * Snapshot lives on `globalThis` (same pattern as the extended-hours snapshot)
 * so that in Next.js dev mode — where instrumentation and route handlers
 * compile into separate server bundles — every bundle shares one instance.
 */
import type { PrismaClient } from "@prisma/client";
import {
  fetchYahooPriorSession,
  type YahooPriorSession,
} from "@/infrastructure/providers/yahoo-chart-http";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PriorSessionSnapshot {
  /** ET calendar date (yyyy-MM-dd) the sweep last ran for. */
  populatedForDate: string | null;
  /** Keyed by user-facing ticker. */
  byTicker: Map<string, YahooPriorSession>;
}

function emptySnapshot(): PriorSessionSnapshot {
  return { populatedForDate: null, byTicker: new Map() };
}

const globalForPrior = globalThis as unknown as {
  __priorSessionSparklines?: PriorSessionSnapshot;
};
if (!globalForPrior.__priorSessionSparklines) {
  globalForPrior.__priorSessionSparklines = emptySnapshot();
}

function getSnapshot(): PriorSessionSnapshot {
  const snap = globalForPrior.__priorSessionSparklines!;
  if (!snap.byTicker) {
    globalForPrior.__priorSessionSparklines = emptySnapshot();
    return globalForPrior.__priorSessionSparklines!;
  }
  return snap;
}

/** Read-only accessor for one ticker's cached prior session, or null. */
export function getPriorSessionSparkline(
  ticker: string,
): YahooPriorSession | null {
  return getSnapshot().byTicker.get(ticker) ?? null;
}

/** ET date the snapshot was last populated for (null when never swept). */
export function getPriorSessionPopulatedDate(): string | null {
  return getSnapshot().populatedForDate;
}

export interface PriorSessionSweepSummary {
  attempted: number;
  applied: number;
  forDate: string;
}

/**
 * Sweep every active universe ticker's prior regular session into the cache.
 * Replaces the snapshot wholesale so a new trading day never serves a stale
 * prior session. Per-ticker failures are skipped (logged) and never abort the
 * batch — a partially-populated cache is better than none.
 */
export async function sweepPriorSessionSparklines(
  db: PrismaClient,
  forDate: string,
  options: { concurrency?: number; perRequestDelayMs?: number } = {},
): Promise<PriorSessionSweepSummary> {
  const concurrency = options.concurrency ?? 5;
  const delay = options.perRequestDelayMs ?? 150;

  const constituents = await db.universeConstituent.findMany({
    where: { security: { isActive: true } },
    select: { security: { select: { ticker: true } } },
  });
  const tickers = Array.from(
    new Set(constituents.map((c) => c.security.ticker)),
  );

  const next = new Map<string, YahooPriorSession>();
  const queue = [...tickers];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      const t = queue[idx]!;
      try {
        const prior = await fetchYahooPriorSession(t);
        if (prior) next.set(t, { ...prior, asOfDate: prior.asOfDate ?? forDate });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[prior-session] ${t}: ${msg} — continuing batch`);
      }
      if (delay > 0) await sleep(delay);
    }
  });
  await Promise.all(workers);

  // Only replace the snapshot when the sweep produced data. A wholesale empty
  // overwrite (e.g. total Yahoo throttle) would blank every Previous Price
  // chart; keeping the prior (at worst one-day-stale) cache and letting the
  // runner retry is strictly better.
  if (next.size > 0) {
    globalForPrior.__priorSessionSparklines = {
      populatedForDate: forDate,
      byTicker: next,
    };
  }

  return { attempted: tickers.length, applied: next.size, forDate };
}
