/**
 * Daily tail-refresh: pulls the last `tailDays` trading sessions for every
 * universe constituent and every benchmark, calling the same services the
 * /api/.../ingest?mode=tail routes use. Idempotent — safe to schedule
 * (Windows Task Scheduler / cron / Vercel Cron / a /schedule remote agent).
 *
 * Usage:
 *   npx tsx scripts/refresh-tail.ts            # default tailDays=10
 *   npx tsx scripts/refresh-tail.ts 20         # custom tailDays
 *
 * Exit codes: 0 on success (even with per-ticker failures, which are logged
 * and reported in the summary), 1 on hard failure (no DB / no universes).
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  refreshBenchmarksTail,
  refreshUniverseTail,
} from "../src/server/services/ingest-universe.service";

async function main() {
  const tailDays = Math.max(1, Number(process.argv[2] ?? "") || 10);
  const startedAt = Date.now();
  console.log(`[refresh-tail] tailDays=${tailDays} starting…`);

  const universes = await prisma.universe.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (universes.length === 0) {
    console.error("[refresh-tail] No universes found. Aborting.");
    process.exit(1);
  }

  let totalBars = 0;
  const failures: string[] = [];

  try {
    const r = await refreshBenchmarksTail(prisma, tailDays);
    totalBars += r.bars;
    console.log(
      `[refresh-tail] benchmarks: ${r.bars} bars, ${r.failed.length} failed`
    );
    for (const f of r.failed) failures.push(`benchmark:${f.code} — ${f.error}`);
  } catch (e) {
    failures.push(`benchmarks — ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const u of universes) {
    try {
      const r = await refreshUniverseTail(prisma, u.id, tailDays);
      totalBars += r.bars;
      console.log(
        `[refresh-tail] ${u.name} (${u.id}): ${r.tickers} tickers, ${r.bars} bars, ${r.failed.length} failed`
      );
      for (const f of r.failed) failures.push(`${u.name}:${f.ticker} — ${f.error}`);
    } catch (e) {
      failures.push(`${u.name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[refresh-tail] done in ${elapsed}s. ${totalBars} bars upserted, ${failures.length} per-ticker failures.`
  );
  if (failures.length > 0) {
    console.log("[refresh-tail] failures (first 10):");
    for (const line of failures.slice(0, 10)) console.log(`  ${line}`);
  }
}

main()
  .catch((e) => {
    console.error("[refresh-tail] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
