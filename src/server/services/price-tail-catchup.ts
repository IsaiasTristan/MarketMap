/**
 * price-tail-catchup - boot-time guard that ingests the latest completed
 * trading session into PriceHistory before the market map is served.
 *
 * Why this exists
 * ---------------
 * Every market-map horizon (1D/5D/1M...) is computed from the close-to-close
 * chain in PriceHistory. When the daily refresh-tail job was missed (PC off
 * over the weekend), the tape lags the last completed session; the regular
 * runner then overlays today's live price onto a stale chain and the grid
 * shows multi-day moves in the 1D/5D columns until the tail catches up.
 *
 * The heavy factor catch-up (precompute-runner) does refresh the tail as its
 * first step, but it is gated on factor-grid freshness, deferred ~180s, and
 * takes ~10 min. This lightweight catch-up runs promptly and independently.
 *
 * The heavy work (tail ingest + market-map recompute) runs in a CHILD process
 * (`npm run job:price-tail` -> scripts/price-tail-catchup.ts), serialized by
 * the shared job queue: running it in the web process at boot used to drive
 * the server straight to its heap ceiling, and a crash mid-run left freshness
 * stale so every supervisor restart re-triggered the full run - a crash-loop
 * amplifier. Only the two cheap staleness aggregates run here; the child
 * REPEATS them and exits early when fresh, so a duplicate spawn across a
 * crash-restart is a near-no-op.
 *
 * Singleton + idempotent: checks at most once per process (boot), and the tail
 * refresh / cache writes are idempotent with the daily job (per-row upserts,
 * last writer wins). Never throws - failures are logged.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  isPriceTailStale,
  isStaleSinceLastClose,
} from "@/lib/factors/diagnostics/precompute-freshness";
import { runJobChild } from "./job-spawner";

let started = false;

/**
 * Fire-and-forget boot catch-up. Two independent staleness checks:
 *   1. Tape stale (freshest PriceHistory bar lags the last completed session)
 *      -> refresh the price tail so the chain reaches the latest close.
 *   2. Cache stale (the market-map cache has not been recomputed since the last
 *      completed session) -> recompute it. This is decoupled from (1): the tape
 *      can be fresh while the cache still holds an older grid (e.g. the daily
 *      job's market-map step was interrupted), which is exactly the case that
 *      leaves the grid showing the prior session's returns.
 * Spawns the catch-up child when EITHER is stale; no-ops only when both are fresh.
 */
export async function maybeRunPriceTailCatchUp(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const max = await prisma.priceHistory.aggregate({
      _max: { tradeDate: true },
    });
    const maxIso = max._max.tradeDate
      ? max._max.tradeDate.toISOString().slice(0, 10)
      : null;
    const tapeStale = isPriceTailStale(maxIso);

    const cacheAgg = await prisma.marketMapSnapshot.aggregate({
      _min: { computedAt: true },
    });
    const cacheStale = isStaleSinceLastClose(cacheAgg._min.computedAt ?? null);

    if (!tapeStale && !cacheStale) {
      console.log(
        `[price-tail-catchup] tape + cache fresh (latest bar ${maxIso ?? "none"}); no catch-up needed.`,
      );
      return;
    }

    console.log(
      `[price-tail-catchup] stale (tapeStale=${tapeStale}, cacheStale=${cacheStale}); spawning catch-up job...`,
    );
    const r = await runJobChild("price-tail", "job:price-tail", [], {
      mode: "enqueue",
    });
    if (r.ok) {
      console.log("[price-tail-catchup] catch-up job completed.");
    } else {
      console.error(`[price-tail-catchup] catch-up job failed: ${r.error}`);
    }
  } catch (e) {
    console.error("[price-tail-catchup] catch-up failed:", e);
  }
}
