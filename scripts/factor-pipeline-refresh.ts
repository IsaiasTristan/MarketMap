/**
 * One-shot trigger for the factor data pipeline refresh — mirrors the
 * `POST /api/analysis/factors/pipeline-refresh` route but skips the
 * Next.js dev server. Useful when no `next dev` is running and you just
 * want to populate the latest Ken French + AQR + Yahoo proxy + FRED
 * DGS1MO RF rows in `FactorReturnDaily`.
 *
 * Usage: `npx tsx scripts/factor-pipeline-refresh.ts`
 */
import { refreshFactorPipeline } from "../src/server/services/factor-pipeline.service";
import { refreshMacroFactorPipeline } from "../src/server/services/factor-pipeline-macro.service";
import { prisma } from "../src/infrastructure/db/client";

async function main() {
  console.log("[refresh] starting FF + Macro pipelines in parallel…");
  const t0 = Date.now();

  const [ff, macro] = await Promise.allSettled([
    refreshFactorPipeline(),
    refreshMacroFactorPipeline(),
  ]);

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[refresh] complete in ${elapsedSec}s`);

  if (ff.status === "fulfilled") {
    console.log("[refresh] FF pipeline:", ff.value);
  } else {
    console.error("[refresh] FF pipeline FAILED:", (ff.reason as Error).message);
  }

  if (macro.status === "fulfilled") {
    const v = macro.value as { ticker?: string; rowsWritten?: number; failed?: unknown[] };
    console.log("[refresh] Macro pipeline:", {
      rowsWritten: v?.rowsWritten,
      failed: Array.isArray(v?.failed) ? v.failed.length : v?.failed,
    });
  } else {
    console.error("[refresh] Macro pipeline FAILED:", (macro.reason as Error).message);
  }

  // Quick freshness recap so the user sees RF moved forward.
  const rows = await prisma.$queryRawUnsafe<Array<{ factorCode: string; last_date: Date }>>(
    `SELECT "factorCode", MAX("tradeDate") AS last_date
     FROM "FactorReturnDaily"
     GROUP BY "factorCode"
     ORDER BY "factorCode"`,
  );
  console.log("\n[refresh] latest tradeDate per factor:");
  for (const r of rows) {
    console.log(`  ${r.factorCode.padEnd(10)} ${r.last_date.toISOString().slice(0, 10)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
