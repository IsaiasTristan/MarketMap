/**
 * Hot-set snapshot refresh (CLI entry point).
 *
 * Child-process twin of the snapshot-refresh runner's tick: recomputes the
 * "hot" DB-backed snapshots (factor-performance RETURN×SP500 + exposure and
 * attribution for every portfolio at MACRO14/252) so warm GET reads stay
 * fast. Spawned by the web server every 5 minutes during REGULAR; safe to run
 * manually — all writes are idempotent upserts.
 *
 * Usage:
 *   npx tsx scripts/snapshot-refresh-hotset.ts
 *
 * Exit 0 on success, 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { refreshHotSet } from "../src/server/services/snapshot-refresh-runner";

async function main() {
  const startedAt = Date.now();
  await refreshHotSet((msg) => console.log(msg));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[snapshot-hotset] done in ${elapsed}s.`);
}

main()
  .catch((e) => {
    console.error("[snapshot-hotset] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
