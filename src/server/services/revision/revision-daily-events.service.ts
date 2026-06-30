/**
 * Engine 1 - DAILY event ingest. Unlike the weekly consensus-estimate snapshot
 * (FMP revises analyst estimates weekly), upgrade/downgrade grades and
 * price-target news are event-level and refresh daily on FMP, so they get their
 * own daily tail.
 *
 * Thin orchestrator over `backfillLegBEvents`, which is already idempotent
 * (`createMany skipDuplicates`): re-running tails only new events into
 * RatingEvent / PriceTargetEvent for the FULL active universe. Per-step
 * failures are captured, not thrown.
 */
import { backfillLegBEvents } from "./leg-b-ingest.service";
import { loadActiveUniverseTickers } from "./reference-ingest.service";

export interface RevisionDailyEventsSummary {
  universeSize: number;
  ratingEvents: number;
  priceTargetEvents: number;
  failures: number;
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
  const tickers = await loadActiveUniverseTickers();
  log(`[daily-events] universe: ${tickers.length} active tickers`);
  if (tickers.length === 0) {
    return { universeSize: 0, ratingEvents: 0, priceTargetEvents: 0, failures: 0 };
  }

  const b = await backfillLegBEvents(tickers, { log });
  return {
    universeSize: tickers.length,
    ratingEvents: b.ratingEvents,
    priceTargetEvents: b.priceTargetEvents,
    failures: b.failures.length,
  };
}
