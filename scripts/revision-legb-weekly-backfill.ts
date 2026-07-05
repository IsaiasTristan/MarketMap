/**
 * Engine 1 — point-in-time weekly Leg-B reconstruction backfill into
 * RevisionLegBWeekly (DB-only, zero FMP calls except --validate).
 *
 * Usage:
 *   npx tsx scripts/revision-legb-weekly-backfill.ts             # full backfill (skip existing rows)
 *   npx tsx scripts/revision-legb-weekly-backfill.ts --refresh   # upsert over existing rows
 *   npx tsx scripts/revision-legb-weekly-backfill.ts --weeks=130 # backward extension depth
 *   npx tsx scripts/revision-legb-weekly-backfill.ts --validate  # cross-check recon vs stored consensus (sample)
 */
import { prisma } from "../src/infrastructure/db/client";
import { backfillLegBWeekly } from "../src/server/services/revision/legb-weekly.service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * Sanity cross-check: for a sample of tickers, compare the reconstructed PT
 * consensus at the latest snapshot date against the stored (live) consensus in
 * RevisionSnapshot. The reconstruction counts only event-covered analysts, so
 * expect correlation, not equality — flag gross divergence.
 */
async function validate(sample = 50) {
  const latest = await prisma.revisionSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latest) {
    console.log("[validate] no snapshots present");
    return;
  }
  const rows = await prisma.revisionSnapshot.findMany({
    where: { snapshotDate: latest.snapshotDate, ptConsensus: { not: null } },
    select: { ticker: true, ptConsensus: true },
    take: sample,
    orderBy: { ticker: "asc" },
  });
  const recon = await prisma.revisionLegBWeekly.findMany({
    where: { snapshotDate: latest.snapshotDate, ticker: { in: rows.map((r) => r.ticker) } },
    select: { ticker: true, ptConsensusRecon: true },
  });
  const reconByTicker = new Map(recon.map((r) => [r.ticker, r.ptConsensusRecon]));
  console.log(`[validate] ticker  stored-PT  recon-PT  ratio`);
  let compared = 0;
  let grossDivergence = 0;
  for (const r of rows) {
    const rc = reconByTicker.get(r.ticker);
    if (rc === null || rc === undefined || r.ptConsensus === null) continue;
    const stored = Number(r.ptConsensus);
    const ratio = rc / stored;
    compared++;
    if (ratio < 0.5 || ratio > 2) grossDivergence++;
    console.log(
      `[validate] ${r.ticker.padEnd(7)} ${stored.toFixed(2).padStart(9)} ${rc.toFixed(2).padStart(9)} ${ratio.toFixed(2).padStart(6)}`,
    );
  }
  console.log(`[validate] compared ${compared}, gross divergence (ratio outside [0.5, 2]): ${grossDivergence}`);
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const weeks = opt("weeks");
  const summary = await backfillLegBWeekly({
    extendWeeks: weeks ? Number(weeks) : undefined,
    refresh: flag("refresh"),
    log,
  });
  console.log("[revision-legb-weekly-backfill] summary:", JSON.stringify(summary, null, 2));
  if (flag("validate")) await validate();
}

main()
  .catch((e) => {
    console.error("[revision-legb-weekly-backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
