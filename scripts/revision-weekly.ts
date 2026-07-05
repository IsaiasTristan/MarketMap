/**
 * Engine 1 — weekly ingestion + scoring job (CLI entry point).
 *
 * Pulls the FMP universe, snapshots both revision legs into the append-only
 * store, then computes signals/scores and the ranked research queue.
 *
 * Usage:
 *   npx tsx scripts/revision-weekly.ts                 # normal weekly run (market-map universe)
 *   npx tsx scripts/revision-weekly.ts --screener      # use the FMP cap-ranked screener instead
 *   npx tsx scripts/revision-weekly.ts --backfill      # also (re)load Leg B event history
 *   npx tsx scripts/revision-weekly.ts --no-reference  # skip universe rebuild
 *   npx tsx scripts/revision-weekly.ts --enrich        # CIK enrichment via profile (screener only)
 *   npx tsx scripts/revision-weekly.ts --date=2026-06-27
 *
 * Logic lives in src/server/services/revision/* so a startup catch-up can
 * share the same code path. Exit 0 on success, 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { runRevisionPipeline } from "../src/server/services/revision/revision-weekly-job.service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const snapshotDate = opt("date");

  const limit = opt("limit");
  const pipeline = await runRevisionPipeline({
    snapshotDate,
    refreshReference: !flag("no-reference"),
    referenceSource: flag("screener") ? "FMP_SCREENER" : "MARKET_MAP",
    backfillEvents: flag("backfill"),
    enrichProfiles: flag("enrich"),
    maxUniverse: limit ? Number(limit) : undefined,
    capturePrices: !flag("no-prices"),
    appendLegB: !flag("no-legb"),
    revalidate: !flag("no-validate"),
    log,
  });
  console.log("[revision-weekly] ingestion summary:", JSON.stringify(pipeline.ingest, null, 2));
  if (pipeline.priceCapture) console.log("[revision-weekly] price capture:", JSON.stringify(pipeline.priceCapture));
  if (pipeline.legBAppend) console.log("[revision-weekly] legB append:", JSON.stringify(pipeline.legBAppend));
  if (pipeline.scoring) console.log("[revision-weekly] scoring summary:", JSON.stringify(pipeline.scoring, null, 2));
  if (pipeline.validation) console.log("[revision-weekly] validation:", JSON.stringify(pipeline.validation));
  if (pipeline.stepErrors.length) console.log("[revision-weekly] step errors:", pipeline.stepErrors);

  if (pipeline.ingest.failures.length) {
    console.log(`[revision-weekly] ${pipeline.ingest.failures.length} failures (first 10):`);
    for (const f of pipeline.ingest.failures.slice(0, 10)) console.log(`  ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("[revision-weekly] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
