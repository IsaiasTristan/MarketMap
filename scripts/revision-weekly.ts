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
import { runRevisionWeekly } from "../src/server/services/revision/revision-weekly-job.service";
import { scoreRevisionWeek } from "../src/server/services/revision/revision-scoring.service";

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
  const ingest = await runRevisionWeekly({
    snapshotDate,
    refreshReference: !flag("no-reference"),
    referenceSource: flag("screener") ? "FMP_SCREENER" : "MARKET_MAP",
    backfillEvents: flag("backfill"),
    enrichProfiles: flag("enrich"),
    maxUniverse: limit ? Number(limit) : undefined,
    log,
  });
  console.log("[revision-weekly] ingestion summary:", JSON.stringify(ingest, (_k, v) => v, 2));

  if (ingest.snapshotsWritten > 0) {
    const scored = await scoreRevisionWeek({ snapshotDate: ingest.snapshotDate, log });
    console.log("[revision-weekly] scoring summary:", JSON.stringify(scored, null, 2));
  } else {
    console.log("[revision-weekly] no snapshots written; skipping scoring.");
  }

  if (ingest.failures.length) {
    console.log(`[revision-weekly] ${ingest.failures.length} failures (first 10):`);
    for (const f of ingest.failures.slice(0, 10)) console.log(`  ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("[revision-weekly] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
