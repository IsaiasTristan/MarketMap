import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { getMarketDataProvider } from "@/infrastructure/providers/factory";
import type { BenchmarkId } from "@/infrastructure/providers/market-data";
import { fetchYahooChartDailyResult } from "@/infrastructure/providers/yahoo-chart-http";
import { fetchYahooDisplayName } from "@/infrastructure/providers/yahoo-quote-http";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";

function toDateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00.000Z`);
}

function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Calendar days between two Date objects (positive when b > a). */
function calendarDaysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** Threshold for promoting a security to delist-candidate. Ratchets only on
 *  hard delist signals from Yahoo (not on transient throttles). */
const DELIST_MIN_CONSECUTIVE_MISSES = 5;
const DELIST_MIN_CALENDAR_DAYS = 90;

/**
 * Outcome of a single per-ticker ingest attempt — exposed so the universe
 * loop can build a richer error report.
 */
export type SecurityIngestOutcome =
  | { kind: "ok"; securityId: string; bars: number }
  | { kind: "skipped-inactive"; ticker: string }
  | { kind: "delisted-signal"; ticker: string; reason: string; flagged: boolean }
  | { kind: "throttled"; ticker: string; reason: string };

/** Ratchet the miss counters; flip `delistCandidate` once the window AND the
 *  consecutive-miss bar are both crossed. Never flips `isActive` — that's
 *  the user's call from the Data tab. */
async function recordDelistMiss(
  db: PrismaClient,
  securityId: string,
  windowYears: number
): Promise<{ flagged: boolean; consecutiveMisses: number }> {
  const sec = await db.security.findUniqueOrThrow({
    where: { id: securityId },
    select: {
      firstMissedAt: true,
      consecutiveMisses: true,
      delistCandidate: true,
    },
  });
  const now = new Date();
  const firstMissedAt = sec.firstMissedAt ?? now;
  const consecutiveMisses = sec.consecutiveMisses + 1;
  // A 10-year empty pull is a strong enough signal to flag immediately —
  // we don't make the user wait 90 days for an unambiguously dead ticker.
  // For shorter (tail) windows we apply the full window+miss-count gate.
  const flagged =
    sec.delistCandidate ||
    (windowYears >= 5 && consecutiveMisses >= 1) ||
    (consecutiveMisses >= DELIST_MIN_CONSECUTIVE_MISSES &&
      calendarDaysBetween(firstMissedAt, now) >= DELIST_MIN_CALENDAR_DAYS);
  await db.security.update({
    where: { id: securityId },
    data: {
      firstMissedAt,
      lastMissedAt: now,
      consecutiveMisses,
      delistCandidate: flagged,
    },
  });
  return { flagged, consecutiveMisses };
}

/** Successful pull resets the miss counters but never auto-clears
 *  `delistCandidate` (a single late-night Yahoo fluke shouldn't unflag a
 *  ticker the user already saw flagged). The Data tab "Mark live" action
 *  is the explicit clear path. */
async function clearDelistMisses(
  db: PrismaClient,
  securityId: string
): Promise<void> {
  await db.security.update({
    where: { id: securityId },
    data: {
      firstMissedAt: null,
      lastMissedAt: null,
      consecutiveMisses: 0,
    },
  });
}

export async function ingestSecurityHistory(
  db: PrismaClient,
  ticker: string,
  years = 10
): Promise<SecurityIngestOutcome> {
  const upper = ticker.trim().toUpperCase();

  // Skip work entirely for tickers the user has already deactivated.
  const existing = await db.security.findUnique({
    where: { ticker: upper },
    select: { id: true, isActive: true },
  });
  if (existing && !existing.isActive) {
    return { kind: "skipped-inactive", ticker: upper };
  }

  const start = yearsAgoIso(years);
  const end = new Date().toISOString().slice(0, 10);
  const result = await fetchYahooChartDailyResult(upper, start, end);

  if (result.kind === "throttled") {
    return { kind: "throttled", ticker: upper, reason: result.reason };
  }

  // Even when Yahoo says "delisted" we still upsert the Security row (so the
  // counters have a place to live and the user can see the row in the Data
  // tab review). We do *not* try to fetch a name for delisted symbols since
  // the quote endpoint will also fail for them.
  const name =
    result.kind === "ok"
      ? await fetchYahooDisplayName(upper)
      : existing
      ? undefined
      : upper;
  const security = await db.security.upsert({
    where: { ticker: upper },
    create: { ticker: upper, name: name ?? upper },
    update: name ? { name, isActive: true } : { isActive: true },
  });

  if (result.kind === "delisted") {
    const { flagged } = await recordDelistMiss(db, security.id, years);
    return {
      kind: "delisted-signal",
      ticker: upper,
      reason: result.reason,
      flagged,
    };
  }

  for (const b of result.bars) {
    await db.priceHistory.upsert({
      where: {
        securityId_tradeDate: {
          securityId: security.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        securityId: security.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
        volume: null,
      },
      update: {
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
      },
    });
  }

  if (result.bars.length > 0) {
    await clearDelistMisses(db, security.id);
  }

  return { kind: "ok", securityId: security.id, bars: result.bars.length };
}

/**
 * Tail refresh: fetch only the last `tailDays` trading sessions (plus a small
 * calendar buffer for weekends/holidays) and upsert into PriceHistory. This is
 * the cheap, idempotent path used to keep the dashboard fresh — no full 10y
 * re-pull, no `onlyMissing` skip.
 */
export async function ingestSecurityTail(
  db: PrismaClient,
  ticker: string,
  tailDays = 10
): Promise<SecurityIngestOutcome> {
  const upper = ticker.trim().toUpperCase();
  const security = await db.security.findUnique({
    where: { ticker: upper },
    select: { id: true, isActive: true },
  });
  if (!security) {
    // Tail refresh only updates already-known tickers. First-time seeding goes
    // through ingestSecurityHistory.
    return { kind: "ok", securityId: "", bars: 0 };
  }
  if (!security.isActive) {
    return { kind: "skipped-inactive", ticker: upper };
  }

  // tailDays is in *trading* days; pad with weekends/holidays so we always
  // cover the requested window.
  const tailWindow = tailDays + Math.ceil(tailDays / 5) * 2 + 5;
  const start = daysAgoIso(tailWindow);
  const end = new Date().toISOString().slice(0, 10);
  const result = await fetchYahooChartDailyResult(upper, start, end);

  if (result.kind === "throttled") {
    return { kind: "throttled", ticker: upper, reason: result.reason };
  }
  if (result.kind === "delisted") {
    const { flagged } = await recordDelistMiss(
      db,
      security.id,
      tailWindow / 365.25
    );
    return {
      kind: "delisted-signal",
      ticker: upper,
      reason: result.reason,
      flagged,
    };
  }

  for (const b of result.bars) {
    await db.priceHistory.upsert({
      where: {
        securityId_tradeDate: {
          securityId: security.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        securityId: security.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
        volume: null,
      },
      update: {
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
      },
    });
  }

  if (result.bars.length > 0) {
    await clearDelistMisses(db, security.id);
  }

  return { kind: "ok", securityId: security.id, bars: result.bars.length };
}

export async function ingestBenchmarkHistory(
  db: PrismaClient,
  code: BenchmarkId,
  years = 10
): Promise<{ benchmarkId: string; bars: number }> {
  await ensureBenchmarksSeeded(db);
  const bench = await db.benchmark.findUniqueOrThrow({ where: { code } });
  const provider = getMarketDataProvider();
  const start = yearsAgoIso(years);
  const end = new Date().toISOString().slice(0, 10);
  const bars = await provider.fetchBenchmarkSeries(code, start, end);

  for (const b of bars) {
    await db.benchmarkPriceHistory.upsert({
      where: {
        benchmarkId_tradeDate: {
          benchmarkId: bench.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        benchmarkId: bench.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
      },
      update: { adjClose: new Decimal(b.adjClose) },
    });
  }

  return { benchmarkId: bench.id, bars: bars.length };
}

export async function ingestBenchmarkTail(
  db: PrismaClient,
  code: BenchmarkId,
  tailDays = 10
): Promise<{ benchmarkId: string; bars: number }> {
  await ensureBenchmarksSeeded(db);
  const bench = await db.benchmark.findUniqueOrThrow({ where: { code } });
  const provider = getMarketDataProvider();
  const start = daysAgoIso(tailDays + Math.ceil(tailDays / 5) * 2 + 5);
  const end = new Date().toISOString().slice(0, 10);
  const bars = await provider.fetchBenchmarkSeries(code, start, end);

  for (const b of bars) {
    await db.benchmarkPriceHistory.upsert({
      where: {
        benchmarkId_tradeDate: {
          benchmarkId: bench.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        benchmarkId: bench.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
      },
      update: { adjClose: new Decimal(b.adjClose) },
    });
  }

  return { benchmarkId: bench.id, bars: bars.length };
}
