/**
 * One-shot cleanup for phantom RF rows written by the previous buggy
 * `tradingDatesAfter` logic in factor-pipeline.service.ts (2026-04-26
 * timezone bug — walked Mon-Fri using local-time `getDay()` mixed with
 * UTC `toISOString()`, so it pushed Saturdays as if they were Fridays
 * and skipped real Mondays). The fix is in place; this script removes
 * RF rows that landed on Saturdays / Sundays so the per-stock candidate
 * window stops including phantom dates.
 *
 * Read targeted: only deletes RF rows where the trade-date is a weekend
 * AND the source is "PROXY" (i.e. not from Ken-French — KF only writes
 * Mon-Fri so this is defensive).
 *
 * Run once after merging the timezone fix, then re-run
 * `scripts/factor-pipeline-refresh.ts` to fill any real Mon-Fri dates
 * that were skipped.
 *
 * Usage: `npx tsx scripts/factor-rf-phantom-cleanup.ts`
 */
import { prisma } from "../src/infrastructure/db/client";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const rows = await prisma.factorReturnDaily.findMany({
    where: { factorCode: "RF", source: "PROXY" },
    select: { id: true, tradeDate: true },
  });

  const phantoms = rows.filter((r) => {
    const dow = r.tradeDate.getUTCDay();
    return dow === 0 || dow === 6;
  });

  console.log(`[cleanup] inspected ${rows.length} PROXY RF rows`);
  console.log(`[cleanup] phantom (Sat/Sun) rows: ${phantoms.length}`);
  for (const r of phantoms) {
    const dowName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
      r.tradeDate.getUTCDay()
    ];
    console.log(`  ${isoDay(r.tradeDate)} ${dowName}  (id=${r.id})`);
  }

  if (phantoms.length === 0) {
    console.log("[cleanup] nothing to delete.");
    return;
  }

  const result = await prisma.factorReturnDaily.deleteMany({
    where: { id: { in: phantoms.map((r) => r.id) } },
  });
  console.log(`[cleanup] deleted ${result.count} phantom RF rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
