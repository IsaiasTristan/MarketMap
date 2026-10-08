/**
 * Engine 1 — materialize RevisionScreenRow + RevisionUniverseWeek, the table
 * the three research screens read (DB-only, zero FMP calls).
 *
 * The weekly pipeline writes the live week automatically; this script is the
 * backfill / rebuild path after a rank-definition change.
 *
 * Usage:
 *   npx tsx scripts/revision-screen-rows.ts                 # latest grid week
 *   npx tsx scripts/revision-screen-rows.ts --all           # full Leg-B grid
 *   npx tsx scripts/revision-screen-rows.ts --dates=2026-09-16,2026-09-09
 */
import { prisma } from "../src/infrastructure/db/client";
import { buildScreenRows } from "../src/server/services/revision/revision-screen-rows.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const all = process.argv.includes("--all");
  const dates = opt("dates")?.split(",").map((d) => d.trim()).filter(Boolean);
  const started = Date.now();
  const summary = await buildScreenRows({
    all,
    snapshotDates: dates,
    log: (m) => console.log(m),
  });
  console.log(
    `[revision-screen-rows] ${summary.rowsWritten} rows over ${summary.weeks} weeks, ` +
      `${summary.universeWeeks} universe rows, engine tags on ${summary.taggedWeek ?? "(no live week)"} ` +
      `in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main()
  .catch((e) => {
    console.error("[revision-screen-rows] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
