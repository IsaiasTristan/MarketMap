/**
 * Commodities forward-curve ingest (AEGIS OData). Runs the same code path as
 * daily-precompute step 7 and the admin route — snapshot upserts + realized
 * monthly history, with the one-time vintage backfill for shallow curves.
 *
 * Usage:
 *   npx tsx scripts/commodities-ingest.ts             # normal daily sweep
 *   npx tsx scripts/commodities-ingest.ts --backfill  # force ~1Y vintage backfill
 *
 * Exit codes: 0 on success, 1 on fatal error or AEGIS auth failure (expired
 * AEGIS_ODATA_TOKEN — refresh it from the platform, username menu bottom-left).
 */
import { prisma } from "../src/infrastructure/db/client";
import { runCommoditiesDailyPrecomputeLocked } from "../src/server/services/commodities-daily-precompute.service";

async function main() {
  const forceBackfill = process.argv.includes("--backfill");
  const outcome = await runCommoditiesDailyPrecomputeLocked({
    forceBackfill,
    log: (msg) => console.log(msg),
  });
  if (outcome.deduped) {
    console.log("[commodities-ingest] skipped — another ingest is already running");
    return;
  }
  const s = outcome.summary!;
  if (s.failed.length > 0) {
    console.log("[commodities-ingest] failures:");
    for (const f of s.failed) console.log(`  ${f.code}: ${f.error}`);
  }
  if (s.authFailed) {
    console.error("[commodities-ingest] AEGIS AUTH FAILED — refresh AEGIS_ODATA_TOKEN in .env");
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("[commodities-ingest] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
