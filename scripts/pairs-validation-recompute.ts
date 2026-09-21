/**
 * Pairs Validation — recompute + re-cache the pooled event study only.
 *
 * Reads the existing PairSnapshot grid, reruns the (now two-way-demeaned)
 * pooled event study, and upserts PairValidationSnapshot(kind
 * "pooled-event-study"). Pure recompute; safe to re-run.
 *
 * Usage: npx tsx scripts/pairs-validation-recompute.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { computeAndCachePairValidation } from "../src/server/services/pairs/pairs-validation.service";

async function main() {
  const t0 = Date.now();
  const r = await computeAndCachePairValidation({ log: (m) => console.log(m) });
  console.log(
    `[pairs-validation-recompute] events=${r.events} effWeeks=${r.effectiveWeeks} ready=${r.headlineReady} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
