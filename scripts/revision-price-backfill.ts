/**
 * Engine 1 — one-time (re-runnable) weekly-close backfill into
 * RevisionPriceSnapshot. Prices are backfillable from FMP even though
 * estimates are not, so gap-score price z's and forward-return validation
 * stats work from day one.
 *
 * Usage:
 *   npx tsx scripts/revision-price-backfill.ts                # full backfill (skip existing rows)
 *   npx tsx scripts/revision-price-backfill.ts --refresh      # upsert over existing rows (heal split adjustments)
 *   npx tsx scripts/revision-price-backfill.ts --weeks=130    # backward extension depth
 *   npx tsx scripts/revision-price-backfill.ts --limit=50     # first N active tickers (smoke test)
 */
import { prisma } from "../src/infrastructure/db/client";
import { backfillPriceHistory } from "../src/server/services/revision/price-ingest.service";
import { loadActiveUniverseTickers } from "../src/server/services/revision/reference-ingest.service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const limit = opt("limit");
  const weeks = opt("weeks");
  const tickers = limit ? (await loadActiveUniverseTickers()).slice(0, Number(limit)) : undefined;
  const summary = await backfillPriceHistory({
    extendWeeks: weeks ? Number(weeks) : undefined,
    tickers,
    refresh: flag("refresh"),
    log,
  });
  console.log("[revision-price-backfill] summary:", JSON.stringify({ ...summary, failures: summary.failures.length }, null, 2));
  if (summary.failures.length) {
    console.log(`[revision-price-backfill] first 10 failures:`);
    for (const f of summary.failures.slice(0, 10)) console.log(`  ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("[revision-price-backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
