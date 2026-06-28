/**
 * Engine 2 — weekly fundamentals ingestion + scoring job (CLI entry point).
 *
 * Pulls standardized statements for the shared universe, snapshots them into the
 * append-only store (FundamentalPeriod write-once + weekly FundamentalSnapshot),
 * then computes the inflection/quality/valuation signals and the ranked
 * discovery queue.
 *
 * Usage:
 *   npx tsx scripts/fundamental-weekly.ts                 # routine weekly run (LIVE provenance)
 *   npx tsx scripts/fundamental-weekly.ts --backfill      # first run: BACKFILL provenance + ~9yr history
 *   npx tsx scripts/fundamental-weekly.ts --reference     # also rebuild the shared universe first (market-map default)
 *   npx tsx scripts/fundamental-weekly.ts --screener      # use the FMP cap-ranked screener instead
 *   npx tsx scripts/fundamental-weekly.ts --limit=25      # cap universe (staged / smoke run)
 *   npx tsx scripts/fundamental-weekly.ts --score-only    # re-score the latest snapshot only (no FMP ingest)
 *   npx tsx scripts/fundamental-weekly.ts --date=2026-06-27
 *
 * Logic lives in src/server/services/fundamental/* so a startup catch-up can
 * share the same code path. Exit 0 on success, 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { runFundamentalWeekly } from "../src/server/services/fundamental/fundamental-weekly-job.service";
import { scoreFundamentalBoxesWeek } from "../src/server/services/fundamental/fundamental-box-scoring.service";

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
  const quarters = opt("quarters");

  // Score-only: re-run scoring against the latest (or --date) stored snapshot
  // without any FMP ingestion. Use to repopulate the discovery payload after a
  // signal/payload change. Reads existing FundamentalPeriod/FundamentalSnapshot.
  if (flag("score-only")) {
    const scored = await scoreFundamentalBoxesWeek({ snapshotDate, log });
    console.log("[fundamental-weekly] score-only summary:", JSON.stringify(scored, null, 2));
    return;
  }

  const ingest = await runFundamentalWeekly({
    snapshotDate,
    refreshReference: flag("reference"),
    referenceSource: flag("screener") ? "FMP_SCREENER" : "MARKET_MAP",
    backfill: flag("backfill"),
    enrichProfiles: flag("enrich"),
    maxUniverse: limit ? Number(limit) : undefined,
    quarters: quarters ? Number(quarters) : undefined,
    log,
  });
  console.log("[fundamental-weekly] ingestion summary:", JSON.stringify(ingest, null, 2));

  if (ingest.snapshotsWritten > 0) {
    const scored = await scoreFundamentalBoxesWeek({ snapshotDate: ingest.snapshotDate, log });
    console.log("[fundamental-weekly] scoring summary:", JSON.stringify(scored, null, 2));
  } else {
    console.log("[fundamental-weekly] no snapshots written; skipping scoring.");
  }

  if (ingest.failures.length) {
    console.log(`[fundamental-weekly] ${ingest.failures.length} failures (first 10):`);
    for (const f of ingest.failures.slice(0, 10)) console.log(`  ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("[fundamental-weekly] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
