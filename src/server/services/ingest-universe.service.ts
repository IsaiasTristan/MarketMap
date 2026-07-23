import type { PrismaClient } from "@prisma/client";
import {
  ingestBenchmarkHistory,
  ingestBenchmarkTail,
  ingestSecurityHistory,
  ingestSecurityTail,
  upsertTailBars,
} from "@/server/services/price-ingest.service";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";
import { autoDeactivateStaleTickers } from "@/server/services/security-health.service";
import {
  fetchFmpEodAdjusted,
  fetchFmpEodBulkByDate,
} from "@/infrastructure/providers/fmp/prices";
import { fmpPool } from "@/infrastructure/providers/fmp/fmp-client";
import { fmpApiKey, priceEodSource } from "@/infrastructure/config/env";
import { lastTradingClose } from "@/lib/factors/diagnostics/precompute-freshness";

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

export interface UniverseTailResult {
  tickers: number;
  bars: number;
  failed: { ticker: string; error: string }[];
  autoDeactivated: string[];
}

/**
 * Tail refresh every constituent of a universe — brings the last `tailDays`
 * trading sessions of the price tape up to the latest completed close. Unlike
 * `ingestUniverseSecurities`, this never skips and never re-fetches 10 years;
 * it's the cheap path used to keep the dashboard fresh on mount and on a
 * schedule (the daily job and the boot catch-up both call it).
 *
 * Source selection (`PRICE_EOD_SOURCE`, default "fmp"). The FMP path is a
 * three-tier cascade (see `refreshUniverseTailFmp`) that replaces the old
 * ~2,900-request Yahoo loop whose anonymous-endpoint throttling used to drop
 * half the universe and leave the tape stale for days:
 *   1. Whole-universe bulk-EOD (one adjusted call per missing date) — cheap
 *      fast-path, best-effort (the bulk endpoint has a strict rate cap).
 *   2. Per-symbol FMP dividend-adjusted for anything tier 1 missed — the
 *      reliable backbone on the general 3,000/min budget, no throttle.
 *   3. Yahoo per-symbol for the residual FMP can't serve (indices, foreign,
 *      OTC) — a small enough count that it never throttles.
 * "yahoo" selects the legacy per-symbol Yahoo path (no-FMP-key envs / fallback).
 */
export async function refreshUniverseTail(
  db: PrismaClient,
  universeId: string,
  tailDays = 10
): Promise<UniverseTailResult> {
  if (priceEodSource() === "fmp" && fmpApiKey()) {
    try {
      return await refreshUniverseTailFmp(db, universeId, tailDays);
    } catch (e) {
      console.error(
        `[ingest:tail] FMP path failed for ${universeId}; falling back to Yahoo per-symbol:`,
        e
      );
    }
  }
  return refreshUniverseTailYahoo(db, universeId, tailDays);
}

/** Beyond this many missing dates, skip the strictly-rate-capped bulk endpoint
 *  and let the per-symbol FMP tier fill the gap. */
const FMP_BULK_MAX_DATES = 3;
/** Politeness gap between bulk-EOD calls (the endpoint's cap is far lower than
 *  the general per-symbol budget). */
const FMP_BULK_GAP_MS = 1200;

/** yyyy-mm-dd `tailDays` trading sessions before `target` (calendar-padded for
 *  weekends/holidays) — the per-symbol FMP fetch window. */
function tailStartIso(targetIso: string, tailDays: number): string {
  const pad = tailDays + Math.ceil(tailDays / 5) * 2 + 5;
  const t = Date.parse(`${targetIso}T12:00:00Z`) - pad * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** yyyy-mm-dd of the last completed trading close, in the server-local clock
 *  convention shared with the freshness checks. */
function lastCloseIso(): string {
  const d = lastTradingClose();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Weekday ISO dates in (fromExclusive, toInclusive], anchored at 12:00Z so DST
 *  never shifts a bucket; capped to the most recent `cap` dates. Holidays are
 *  not filtered — a bulk call for a holiday simply returns no rows (harmless). */
export function tradingDatesBetween(
  fromExclusiveIso: string,
  toInclusiveIso: string,
  cap: number
): string[] {
  const start = Date.parse(`${fromExclusiveIso}T12:00:00Z`);
  const end = Date.parse(`${toInclusiveIso}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out.slice(-cap);
}

/** Universe ticker → FMP bulk symbol (class-share `.`→`-`, e.g. BRK.B→BRK-B). */
export function fmpBulkSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.([A-Z])$/, "-$1");
}

/**
 * FMP-sourced tail refresh — a three-tier cascade (bulk fast-path → per-symbol
 * FMP backbone → Yahoo reconcile) that brings every active ticker up to the
 * last close using the licensed, adjusted FMP feed, with Yahoo only for the
 * handful FMP can't serve. Reports rich freshness metadata on the RefreshJob
 * so a partial fill is visible, never silent.
 */
async function refreshUniverseTailFmp(
  db: PrismaClient,
  universeId: string,
  tailDays: number
): Promise<UniverseTailResult> {
  const job = await db.refreshJob.create({
    data: {
      type: "MARKET_DATA",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { universeId, mode: "fmp-tail", tailDays },
    },
  });
  const failed: { ticker: string; error: string }[] = [];
  let bulkBars = 0;
  let bulkTickers = 0;
  let fmpBars = 0;
  let fmpTickers = 0;
  let reconciled = 0;
  try {
    const cons = await db.universeConstituent.findMany({
      where: { universeId, security: { isActive: true } },
      include: {
        security: {
          select: {
            id: true,
            ticker: true,
            priceHistory: {
              select: { tradeDate: true },
              orderBy: { tradeDate: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    if (cons.length === 0) {
      await db.refreshJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          metadata: { universeId, mode: "fmp-tail", tailDays, tickers: 0 },
        },
      });
      return { tickers: 0, bars: 0, failed: [], autoDeactivated: [] };
    }

    const target = lastCloseIso();
    const fromIso = tailStartIso(target, tailDays);

    // Tier 1 covers only the most recent few sessions (up to FMP_BULK_MAX_DATES)
    // — the gap the freshest cohort of the universe has. A single chronic
    // straggler must NOT pin the whole universe to a wide bulk fan-out; deeper
    // stragglers are filled by tier 2 on the per-symbol budget. Skip the bulk
    // call entirely when the whole universe is already current.
    const anyBehind = cons.some((c) => {
      const d = c.security.priceHistory[0]?.tradeDate;
      return (d ? d.toISOString().slice(0, 10) : "") < target;
    });
    const dates = anyBehind
      ? tradingDatesBetween(
          tailStartIso(target, FMP_BULK_MAX_DATES),
          target,
          FMP_BULK_MAX_DATES
        )
      : [];

    // ── Tier 1: whole-universe bulk EOD (best-effort fast-path) ──────────────
    // One adjusted call per recent session covers ~99% of the universe. Cheap
    // in steady state (~1 date). Non-throwing: the bulk endpoint's rate cap is
    // far below the per-symbol budget, so on a 429 we stop and let tier 2 fill
    // the rest instead of failing the run.
    if (dates.length > 0) {
      const wanted = new Set(cons.map((c) => fmpBulkSymbol(c.security.ticker)));
      const barsBySym = new Map<
        string,
        { date: string; adjClose: number; close?: number | null }[]
      >();
      for (const date of dates) {
        try {
          const bySym = await fetchFmpEodBulkByDate(date, wanted);
          for (const [sym, bar] of bySym) {
            const arr = barsBySym.get(sym) ?? [];
            arr.push({ date, adjClose: bar.adjClose, close: bar.close });
            barsBySym.set(sym, arr);
          }
        } catch (e) {
          console.warn(
            `[ingest:tail:fmp] bulk ${date} failed (${
              e instanceof Error ? e.message : String(e)
            }); deferring to per-symbol.`
          );
          break;
        }
        if (FMP_BULK_GAP_MS > 0) await sleep(FMP_BULK_GAP_MS);
      }
      for (const c of cons) {
        const bars = barsBySym.get(fmpBulkSymbol(c.security.ticker));
        if (!bars || bars.length === 0) continue;
        try {
          const { upserted, rescaled } = await upsertTailBars(
            db,
            c.security.id,
            bars
          );
          if (rescaled) {
            await ingestSecurityHistory(db, c.security.ticker);
          } else {
            bulkBars += upserted;
            if (upserted > 0) bulkTickers += 1;
          }
        } catch (e) {
          failed.push({
            ticker: c.security.ticker,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // ── Tier 2: per-symbol FMP dividend-adjusted (reliable backbone) ─────────
    // Everything tier 1 didn't bring current, fetched on the general
    // 3,000/min budget (no throttle) — so a bulk outage degrades to per-symbol
    // FMP for the whole universe rather than falling back to Yahoo.
    const fmpStragglers = await findStragglers(db, cons, target);
    const { failures: fmpFailures } = await fmpPool(
      fmpStragglers,
      async (c) => {
        const bars = await fetchFmpEodAdjusted(
          fmpBulkSymbol(c.security.ticker),
          fromIso,
          target
        );
        if (bars.length === 0) return;
        const { upserted, rescaled } = await upsertTailBars(
          db,
          c.security.id,
          bars
        );
        if (rescaled) {
          await ingestSecurityHistory(db, c.security.ticker);
          return;
        }
        if (upserted > 0) {
          fmpBars += upserted;
          fmpTickers += 1;
        }
      },
      { concurrency: 8 }
    );
    for (const f of fmpFailures) {
      failed.push({ ticker: f.item.security.ticker, error: f.error });
    }

    // ── Tier 3: Yahoo per-symbol reconcile ──────────────────────────────────
    // Names FMP can't serve at all (indices ^VIX/^VVIX, foreign .DU, OTC ADRs)
    // plus anything still short. Small residual, so no throttle risk;
    // ingestSecurityTail also records misses / flags genuinely delisted names.
    const stragglers = await findStragglers(db, cons, target);
    let cursor = 0;
    const workers = Array.from({ length: INGEST_CONCURRENCY }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= stragglers.length) return;
        const c = stragglers[idx]!;
        try {
          const r = await ingestSecurityTail(db, c.security.ticker, tailDays);
          if (r.kind === "ok" && r.bars > 0) reconciled += 1;
          else if (r.kind === "delisted-signal")
            failed.push({
              ticker: c.security.ticker,
              error: `delisted signal: ${r.reason}`,
            });
          else if (r.kind === "throttled")
            failed.push({
              ticker: c.security.ticker,
              error: `throttled: ${r.reason}`,
            });
        } catch (e) {
          failed.push({
            ticker: c.security.ticker,
            error: e instanceof Error ? e.message : String(e),
          });
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
    const stillMissing = (await findStragglers(db, cons, target)).length;

    console.log(
      `[ingest:tail:fmp] ${universeId}: target=${target} dates=${dates.length} ` +
        `bulk=${bulkTickers} (${bulkBars} bars) fmp=${fmpTickers} (${fmpBars} bars) ` +
        `yahooReconciled=${reconciled} of ${cons.length} — ` +
        `stillBehind=${stillMissing} deactivated=${autoDeactivated.length}`
    );

    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        errorMessage:
          stillMissing > 0
            ? `${stillMissing} ticker(s) still behind ${target} after reconcile`
            : null,
        metadata: {
          universeId,
          mode: "fmp-tail",
          tailDays,
          target,
          requestedDates: dates.length,
          bulkBars,
          bulkTickers,
          fmpBars,
          fmpTickers,
          reconciledTickers: reconciled,
          stillMissing,
          failed: failed.length,
          autoDeactivated: autoDeactivated.length,
        },
      },
    });
    return {
      tickers: bulkTickers + fmpTickers + reconciled,
      bars: bulkBars + fmpBars,
      failed,
      autoDeactivated,
    };
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

/** Active constituents whose newest stored bar is older than `target`. */
async function findStragglers(
  db: PrismaClient,
  cons: { security: { id: string; ticker: string } }[],
  target: string
): Promise<{ security: { id: string; ticker: string } }[]> {
  const maxRows = await db.priceHistory.groupBy({
    by: ["securityId"],
    _max: { tradeDate: true },
    where: { securityId: { in: cons.map((c) => c.security.id) } },
  });
  const maxBySec = new Map(
    maxRows.map((r) => [
      r.securityId,
      r._max.tradeDate ? r._max.tradeDate.toISOString().slice(0, 10) : "",
    ])
  );
  return cons.filter((c) => (maxBySec.get(c.security.id) ?? "") < target);
}

/**
 * Legacy per-symbol Yahoo tail refresh. Retained as the fallback for
 * `PRICE_EOD_SOURCE=yahoo` and for environments without an FMP key.
 */
async function refreshUniverseTailYahoo(
  db: PrismaClient,
  universeId: string,
  tailDays = 10
): Promise<UniverseTailResult> {
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
