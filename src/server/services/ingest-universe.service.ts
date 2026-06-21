import type { PrismaClient } from "@prisma/client";
import {
  ingestBenchmarkHistory,
  ingestBenchmarkTail,
  ingestSecurityHistory,
  ingestSecurityTail,
} from "@/server/services/price-ingest.service";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";
import { autoDeactivateStaleTickers } from "@/server/services/security-health.service";

/** A constituent is considered "primed" once it has at least this many bars. */
const MIN_BARS_FOR_ANALYTICS = 5;

/**
 * How many ticker ingests run in parallel. Yahoo throttles aggressively from a
 * single IP, so we keep this low. Each worker also sleeps briefly between
 * tickers so we don't burst.
 */
const INGEST_CONCURRENCY = 3;
const INGEST_PER_REQUEST_DELAY_MS = 150;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type IngestUniverseOptions = {
  /** When true, skip securities that already have ≥ MIN_BARS_FOR_ANALYTICS bars. */
  onlyMissing?: boolean;
};

export async function ingestUniverseSecurities(
  db: PrismaClient,
  universeId: string,
  years = 10,
  options: IngestUniverseOptions = {}
): Promise<{
  tickers: number;
  bars: number;
  skipped: number;
  failed: { ticker: string; error: string }[];
  autoDeactivated: string[];
}> {
  const job = await db.refreshJob.create({
    data: {
      type: "MARKET_DATA",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { universeId, onlyMissing: !!options.onlyMissing },
    },
  });
  let bars = 0;
  let processed = 0;
  let skipped = 0;
  const failed: { ticker: string; error: string }[] = [];
  try {
    const cons = await db.universeConstituent.findMany({
      where: { universeId },
      include: {
        security: {
          include: { _count: { select: { priceHistory: true } } },
        },
      },
    });

    const queue: { ticker: string }[] = [];
    for (const c of cons) {
      // Skip user-deactivated tickers — they live in the Securities Health
      // panel until the user explicitly reactivates them.
      if (!c.security.isActive) {
        skipped += 1;
        continue;
      }
      if (
        options.onlyMissing &&
        c.security._count.priceHistory >= MIN_BARS_FOR_ANALYTICS
      ) {
        skipped += 1;
        continue;
      }
      queue.push({ ticker: c.security.ticker });
    }

    // Bounded-concurrency worker pool. We can't blast Yahoo with hundreds of
    // simultaneous requests (it returns HTTP 401/429 throttle errors), so a
    // few workers each pulling from a shared queue with a small per-request
    // delay gives the best balance of throughput and reliability.
    let cursor = 0;
    const workers = Array.from({ length: INGEST_CONCURRENCY }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const { ticker } = queue[idx]!;
        try {
          const r = await ingestSecurityHistory(db, ticker, years);
          if (r.kind === "ok") {
            bars += r.bars;
            processed += 1;
          } else if (r.kind === "delisted-signal") {
            failed.push({
              ticker,
              error: r.flagged
                ? `delisted (flagged for review): ${r.reason}`
                : `delisted signal: ${r.reason}`,
            });
          } else if (r.kind === "throttled") {
            failed.push({ ticker, error: `throttled: ${r.reason}` });
          } else {
            // skipped-inactive — user already opted this one out; not a failure.
            skipped += 1;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push({ ticker, error: msg });
          // Per-ticker failure (Yahoo 404 / rate limit / network) must not
          // abort the rest of the batch. Continue and surface the count to
          // the caller.
          console.warn(`[ingest] ${ticker}: ${msg} — continuing batch`);
        }
        if (INGEST_PER_REQUEST_DELAY_MS > 0) {
          await sleep(INGEST_PER_REQUEST_DELAY_MS);
        }
      }
    });
    await Promise.all(workers);
    // After every active ticker has had a chance to refresh, prune any that
    // remain weeks behind the universe — they are almost certainly delisted
    // / acquired and would otherwise pin the "Bars through" banner.
    const { deactivated: autoDeactivated } = await autoDeactivateStaleTickers(
      db,
      universeId
    );
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: failed.length > 0 && processed === 0 ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        errorMessage:
          failed.length > 0
            ? `${failed.length} ticker(s) failed (e.g. ${failed
                .slice(0, 3)
                .map((f) => f.ticker)
                .join(", ")})`
            : null,
        metadata: {
          universeId,
          tickers: processed,
          skipped,
          failed: failed.length,
          bars,
          onlyMissing: !!options.onlyMissing,
          autoDeactivated: autoDeactivated.length,
        },
      },
    });
    return { tickers: processed, bars, skipped, failed, autoDeactivated };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

/**
 * Tail refresh every constituent of a universe — pulls the last `tailDays`
 * trading sessions and upserts. Unlike `ingestUniverseSecurities`, this never
 * skips and never re-fetches 10 years; it's the cheap path used to keep the
 * dashboard fresh on mount and on a schedule.
 */
export async function refreshUniverseTail(
  db: PrismaClient,
  universeId: string,
  tailDays = 10
): Promise<{
  tickers: number;
  bars: number;
  failed: { ticker: string; error: string }[];
  autoDeactivated: string[];
}> {
  const job = await db.refreshJob.create({
    data: {
      type: "MARKET_DATA",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { universeId, mode: "tail", tailDays },
    },
  });
  let bars = 0;
  let processed = 0;
  const failed: { ticker: string; error: string }[] = [];
  try {
    const cons = await db.universeConstituent.findMany({
      where: { universeId, security: { isActive: true } },
      include: { security: true },
    });
    const queue = cons.map((c) => ({ ticker: c.security.ticker }));

    let cursor = 0;
    const workers = Array.from({ length: INGEST_CONCURRENCY }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const { ticker } = queue[idx]!;
        try {
          const r = await ingestSecurityTail(db, ticker, tailDays);
          if (r.kind === "ok") {
            bars += r.bars;
            processed += 1;
          } else if (r.kind === "delisted-signal") {
            failed.push({
              ticker,
              error: r.flagged
                ? `delisted (flagged for review): ${r.reason}`
                : `delisted signal: ${r.reason}`,
            });
          } else if (r.kind === "throttled") {
            failed.push({ ticker, error: `throttled: ${r.reason}` });
          }
          // skipped-inactive doesn't reach here — query already filtered.
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failed.push({ ticker, error: msg });
          console.warn(`[ingest:tail] ${ticker}: ${msg} — continuing batch`);
        }
        if (INGEST_PER_REQUEST_DELAY_MS > 0) {
          await sleep(INGEST_PER_REQUEST_DELAY_MS);
        }
      }
    });
    await Promise.all(workers);
    const { deactivated: autoDeactivated } = await autoDeactivateStaleTickers(
      db,
      universeId
    );
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: failed.length > 0 && processed === 0 ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        errorMessage:
          failed.length > 0
            ? `${failed.length} ticker(s) failed (e.g. ${failed
                .slice(0, 3)
                .map((f) => f.ticker)
                .join(", ")})`
            : null,
        metadata: {
          universeId,
          mode: "tail",
          tailDays,
          tickers: processed,
          failed: failed.length,
          bars,
          autoDeactivated: autoDeactivated.length,
        },
      },
    });
    return { tickers: processed, bars, failed, autoDeactivated };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

export async function refreshBenchmarksTail(
  db: PrismaClient,
  tailDays = 10
): Promise<{ bars: number; failed: { code: string; error: string }[] }> {
  await ensureBenchmarksSeeded(db);
  const job = await db.refreshJob.create({
    data: {
      type: "BENCHMARK",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { mode: "tail", tailDays },
    },
  });
  let bars = 0;
  const failed: { code: string; error: string }[] = [];
  try {
    for (const code of ["SP500", "NASDAQ", "DOW"] as const) {
      try {
        const r = await ingestBenchmarkTail(db, code, tailDays);
        bars += r.bars;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ code, error: msg });
        console.warn(`[ingest:benchmark:tail] ${code}: ${msg} — continuing`);
      }
    }
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: failed.length === 3 ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        errorMessage:
          failed.length > 0
            ? `${failed.length} benchmark(s) failed (${failed
                .map((f) => f.code)
                .join(", ")})`
            : null,
        metadata: { mode: "tail", tailDays, bars, failed: failed.length },
      },
    });
    return { bars, failed };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

export async function ingestAllBenchmarks(
  db: PrismaClient,
  years = 10,
  options: { onlyMissing?: boolean } = {}
): Promise<{ bars: number; skipped: number }> {
  await ensureBenchmarksSeeded(db);
  const job = await db.refreshJob.create({
    data: {
      type: "BENCHMARK",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { onlyMissing: !!options.onlyMissing },
    },
  });
  let bars = 0;
  let skipped = 0;
  const failed: { code: string; error: string }[] = [];
  try {
    for (const code of ["SP500", "NASDAQ", "DOW"] as const) {
      if (options.onlyMissing) {
        const bench = await db.benchmark.findUnique({ where: { code } });
        if (bench) {
          const cnt = await db.benchmarkPriceHistory.count({
            where: { benchmarkId: bench.id },
          });
          if (cnt >= MIN_BARS_FOR_ANALYTICS) {
            skipped += 1;
            continue;
          }
        }
      }
      try {
        const r = await ingestBenchmarkHistory(db, code, years);
        bars += r.bars;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push({ code, error: msg });
        console.warn(`[ingest:benchmark] ${code}: ${msg} — continuing`);
      }
    }
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: failed.length === 3 ? "FAILED" : "SUCCEEDED",
        finishedAt: new Date(),
        errorMessage:
          failed.length > 0
            ? `${failed.length} benchmark(s) failed (${failed
                .map((f) => f.code)
                .join(", ")})`
            : null,
        metadata: {
          bars,
          skipped,
          failed: failed.length,
          onlyMissing: !!options.onlyMissing,
        },
      },
    });
    return { bars, skipped };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}
