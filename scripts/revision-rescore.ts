/**
 * Engine 1 — re-score every existing RevisionScore week on the CURRENT signal
 * definitions (DB-only, zero FMP calls). Run after a signal-math change so the
 * scored history is consistent with the live code — here, the Leg-A
 * fiscal-year-roll fix (like-for-like period revisions).
 *
 * Chronological order matters: scoreRevisionWeek reads the prior week for
 * week-over-week deltas and prior transition state, so weeks are re-scored
 * oldest -> newest to rebuild the transition chain correctly.
 *
 * Usage:
 *   npx tsx scripts/revision-rescore.ts            # re-score all snapshot dates
 *   npx tsx scripts/revision-rescore.ts --from=2026-06-27
 */
import { prisma } from "../src/infrastructure/db/client";
import { scoreRevisionWeek } from "../src/server/services/revision/revision-scoring.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const from = opt("from");
  const dates = await prisma.revisionSnapshot.findMany({
    distinct: ["snapshotDate"],
    orderBy: { snapshotDate: "asc" },
    select: { snapshotDate: true },
  });
  const isoDates = dates
    .map((d) => isoOf(d.snapshotDate))
    .filter((d) => (from ? d >= from : true));
  console.log(`[revision-rescore] re-scoring ${isoDates.length} snapshot weeks (oldest -> newest)`);

  for (const snapshotDate of isoDates) {
    const summary = await scoreRevisionWeek({ snapshotDate, log: () => {} });
    console.log(
      `[revision-rescore] ${snapshotDate}: scored ${summary.scored}, new arrivals ${summary.newArrivals}, ` +
        `transitions ${summary.transitionsWritten}, legA depth ${summary.legADepthWeeks}w`,
    );
  }
  console.log("[revision-rescore] done");
}

main()
  .catch((e) => {
    console.error("[revision-rescore] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
