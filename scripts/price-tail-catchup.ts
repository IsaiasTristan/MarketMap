/**
 * Boot-time price-tail catch-up (CLI entry point).
 *
 * Child-process twin of src/server/services/price-tail-catchup.ts: refresh the
 * last TAIL_DAYS sessions into PriceHistory when the tape lags the last
 * completed close, then recompute the market-map cache when either the tape or
 * the cache is stale. The web-server runner does the cheap staleness checks
 * in-process and spawns this job for the heavy work; the checks are REPEATED
 * here so a duplicate spawn (e.g. across a crash-restart) exits as a no-op.
 *
 * Usage:
 *   npx tsx scripts/price-tail-catchup.ts
 *
 * Exit 0 on success or fresh no-op, 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  isPriceTailStale,
  isStaleSinceLastClose,
} from "../src/lib/factors/diagnostics/precompute-freshness";
import {
  refreshBenchmarksTail,
  refreshUniverseTail,
} from "../src/server/services/ingest-universe.service";
import { precomputeAllMarketMaps } from "../src/server/services/market-map-cache.service";

const TAIL_DAYS = 10;

async function main() {
  const max = await prisma.priceHistory.aggregate({ _max: { tradeDate: true } });
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

  // Cache staleness: use the OLDEST computedAt across all combos so a single
  // stale row triggers a rebuild.
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
}

main()
  .catch((e) => {
    console.error("[price-tail-catchup] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
