/**
 * Precompute + cache the per-stock factor grid for every (model, window) the
 * UI exposes — WITHOUT refreshing prices or the factor pipeline first. Use
 * this when prices/factors are already current and you only need to rebuild
 * the cached grids (e.g. after editing the ticker universe).
 *
 * For the full daily pre-open chain (prices -> factors -> grids) use
 * `scripts/daily-precompute.ts` instead.
 *
 * Usage:
 *   npx tsx scripts/precompute-per-stock-grid.ts
 *
 * Exit codes: 0 on success (per-combo failures are logged), 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { precomputeAllPerStockGrids } from "../src/server/services/factor-per-stock-cache.service";

async function main() {
  console.log("[precompute-grid] starting…");
  const grid = await precomputeAllPerStockGrids();
  for (const e of grid.entries) {
    const detail =
      e.status === "ok"
        ? `${e.rows} rows, asOf ${e.asOfDate}`
        : e.status === "error"
          ? `ERROR ${e.error}`
          : "empty";
    console.log(
      `[precompute-grid] ${e.model} w${e.window}: ${e.status} (${detail}) in ${(e.elapsedMs / 1000).toFixed(1)}s`,
    );
  }
  const ok = grid.entries.filter((e) => e.status === "ok").length;
  console.log(
    `[precompute-grid] done in ${(grid.totalMs / 1000).toFixed(1)}s. ${ok}/${grid.entries.length} grids cached.`,
  );
}

main()
  .catch((e) => {
    console.error("[precompute-grid] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
