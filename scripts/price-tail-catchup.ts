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

// Load .env for standalone tsx runs (Next.js loads it for the app; CLI scripts
// don't). Required so refreshUniverseTail sees FMP_API_KEY and uses the bulk
// EOD path instead of silently falling back to the per-symbol Yahoo path.
if (!process.env.FMP_API_KEY) {
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(".env");
  } catch {
    /* .env optional */
  }
}

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

    const runTail = async (): Promise<{ bars: number; failed: number }> => {
      let bars = 0;
      let failed = 0;
      try {
        const r = await refreshBenchmarksTail(prisma, TAIL_DAYS);
        bars += r.bars;
        failed += r.failed.length;
      } catch (e) {
        console.error("[price-tail-catchup] benchmark tail failed:", e);
      }
      for (const u of universes) {
        try {
          const r = await refreshUniverseTail(prisma, u.id, TAIL_DAYS);
          bars += r.bars;
          failed += r.failed.length;
        } catch (e) {
          console.error(`[price-tail-catchup] ${u.name} tail failed:`, e);
        }
      }
      return { bars, failed };
    };

    // Bounded same-day retry. With the FMP bulk path, ~99% of the universe is
    // filled in a handful of calls, so a LARGE residual signals a systemic
    // problem (FMP bulk unavailable -> Yahoo per-symbol fallback getting
    // throttled), not the handful of permanently-absent names (indices /
    // delisted). Retry once after a cooldown so a transient outage self-heals
    // within the run instead of leaving half the tape stale until tomorrow.
    const SYSTEMIC_FAILURE_THRESHOLD = 100;
    const RETRY_COOLDOWN_MS = 60_000;
    const MAX_PASSES = 2;
    let totalBars = 0;
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const { bars, failed } = await runTail();
      totalBars += bars;
      console.log(
        `[price-tail-catchup] pass ${pass}/${MAX_PASSES}: ${bars} bars, ${failed} failures.`,
      );
      if (failed < SYSTEMIC_FAILURE_THRESHOLD || pass === MAX_PASSES) break;
      console.warn(
        `[price-tail-catchup] ${failed} failures (>= ${SYSTEMIC_FAILURE_THRESHOLD}); retrying after ${RETRY_COOLDOWN_MS / 1000}s cooldown...`,
      );
      await new Promise((r) => setTimeout(r, RETRY_COOLDOWN_MS));
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
