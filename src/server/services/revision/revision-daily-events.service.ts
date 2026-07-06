/**
 * Engine 1 - DAILY event ingest. Unlike the weekly consensus-estimate snapshot
 * (FMP revises analyst estimates weekly), upgrade/downgrade grades and
 * price-target news are event-level and refresh daily on FMP, so they get their
 * own daily tail.
 *
 * Also onboards NEWLY-HELD portfolio names daily (universe = curated ∪ held):
 * a position added today gets its reference row + a targeted snapshot (Leg A/B
 * + next-earnings date) patched onto the LATEST EXISTING snapshot date, so it
 * shows up in the calendar / Overview signal modules within a day instead of
 * waiting for the weekly rebuild. Reads like getCalendar load the single
 * latest snapshot date — a targeted run must never create a new sparse date.
 *
 * Thin orchestrator over `backfillLegBEvents`, which is already idempotent
 * (`createMany skipDuplicates`): re-running tails only new events into
 * RatingEvent / PriceTargetEvent for the FULL active universe. Per-step
 * failures are captured, not thrown.
 */
import { prisma } from "@/infrastructure/db/client";
import { loadAllHeldTickers } from "@/server/services/position.service";
import { backfillLegBEvents } from "./leg-b-ingest.service";
import {
  ensureHeldReferences,
  loadActiveUniverseTickers,
} from "./reference-ingest.service";
import { runRevisionWeekly } from "./revision-weekly-job.service";

export interface RevisionDailyEventsSummary {
  universeSize: number;
  ratingEvents: number;
  priceTargetEvents: number;
  /** Newly-held names onboarded into the universe this run. */
  onboarded: number;
  failures: number;
}

/**
 * Onboard held tickers that lack an active reference row: ensure the reference
 * (FMP profile taxonomy), then run a targeted snapshot for just those names at
 * the latest EXISTING snapshot date (writes estimates/PT consensus +
 * nextEarningsDate). Skips the snapshot on a fresh DB (weekly handles it).
 * Never throws.
 */
async function onboardNewlyHeldNames(
  log: (msg: string) => void,
): Promise<{ onboarded: string[]; failures: string[] }> {
  const failures: string[] = [];
  try {
    const [held, activeRefs] = await Promise.all([
      loadAllHeldTickers(),
      prisma.revisionReference.findMany({
        where: { isActive: true },
        select: { ticker: true },
      }),
    ]);
    const active = new Set(activeRefs.map((r) => r.ticker));
    const missing = held.filter((t) => !active.has(t));
    if (missing.length === 0) return { onboarded: [], failures };

    log(`[daily-events] onboarding ${missing.length} held name(s): ${missing.join(", ")}`);
    const ensured = await ensureHeldReferences(missing, { log });
    failures.push(...ensured.failures);
    if (ensured.ensured.length === 0) return { onboarded: [], failures };

    const latest = await prisma.revisionSnapshot.findFirst({
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true },
    });
    if (latest) {
      const summary = await runRevisionWeekly({
        tickers: ensured.ensured,
        snapshotDate: latest.snapshotDate.toISOString().slice(0, 10),
        refreshReference: false,
        log,
      });
      failures.push(...summary.failures);
    }
    return { onboarded: ensured.ensured, failures };
  } catch (e) {
    failures.push(`held-onboard: ${e instanceof Error ? e.message : String(e)}`);
    return { onboarded: [], failures };
  }
}

/**
 * Tail today's rating + price-target events for every active universe ticker.
 * Idempotent: existing events are deduped by their unique constraint, so only
 * genuinely new rows are written.
 */
export async function runRevisionDailyEvents(
  opts: { log?: (msg: string) => void } = {},
): Promise<RevisionDailyEventsSummary> {
  const log = opts.log ?? (() => {});

  const onboard = await onboardNewlyHeldNames(log);
  for (const f of onboard.failures.slice(0, 10)) log(`[daily-events] onboard: ${f}`);

  const tickers = await loadActiveUniverseTickers();
  log(`[daily-events] universe: ${tickers.length} active tickers`);
  if (tickers.length === 0) {
    return {
      universeSize: 0,
      ratingEvents: 0,
      priceTargetEvents: 0,
      onboarded: onboard.onboarded.length,
      failures: onboard.failures.length,
    };
  }

  const b = await backfillLegBEvents(tickers, { log });
  return {
    universeSize: tickers.length,
    ratingEvents: b.ratingEvents,
    priceTargetEvents: b.priceTargetEvents,
    onboarded: onboard.onboarded.length,
    failures: onboard.failures.length + b.failures.length,
  };
}
