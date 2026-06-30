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
 * takes ~10 min. This lightweight catch-up runs promptly and independently:
 * refresh the price tail, then rewrite the market-map cache on the now-complete
 * tape. It skips the factor regressions entirely.
 *
 * Singleton + idempotent: runs at most once per process (boot), and the tail
 * refresh / cache writes are idempotent with the daily job (per-row upserts,
 * last writer wins). Never throws - failures are logged.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  isPriceTailStale,
  isStaleSinceLastClose,
} from "@/lib/factors/diagnostics/precompute-freshness";
import {
  refreshBenchmarksTail,
  refreshUniverseTail,
} from "./ingest-universe.service";
import { precomputeAllMarketMaps } from "./market-map-cache.service";

const TAIL_DAYS = 10;

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
 * Recomputes the cache when EITHER is stale; no-ops only when both are fresh.
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

    if (tapeStale) {
      console.log(
        `[price-tail-catchup] tape stale (latest bar ${maxIso ?? "none"}); refreshing price tail...`,
      );
      const universes = await prisma.universe.findMany({
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      });
      if (universes.length === 0) {
        console.warn("[price-tail-catchup] no universes configured; skipping.");
        return;
      }
      let totalBars = 0;
      try {
        const r = await refreshBenchmarksTail(prisma, TAIL_DAYS);
        totalBars += r.bars;
      } catch (e) {
        console.error("[price-tail-catchup] benchmark tail failed:", e);
      }
      for (const u of universes) {
        try {
          const r = await refreshUniverseTail(prisma, u.id, TAIL_DAYS);
          totalBars += r.bars;
        } catch (e) {
          console.error(`[price-tail-catchup] ${u.name} tail failed:`, e);
        }
      }
      console.log(`[price-tail-catchup] ingested ${totalBars} bars.`);
    }

    // Cache staleness: the freshest the cache could legitimately be is "since
    // the last completed close". Use the OLDEST computedAt across all combos so
    // a single stale row triggers a rebuild.
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
      `[price-tail-catchup] recomputing market-map cache (tapeStale=${tapeStale}, cacheStale=${cacheStale})...`,
    );
    const mm = await precomputeAllMarketMaps();
    const ok = mm.entries.filter((e) => e.status === "ok").length;
    console.log(
      `[price-tail-catchup] done: ${ok}/${mm.entries.length} market-map grids cached.`,
    );
  } catch (e) {
    console.error("[price-tail-catchup] catch-up failed:", e);
  }
}
