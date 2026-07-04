/**
 * One-time backfill after the `tier` (Int → FundTier enum) + `categorySort`
 * migration. Sets, per existing fund matched on CIK:
 *   • categorySort  = CATEGORY_TIER[category]  (derived; safe to overwrite)
 *   • tier          = the seed's tier (default "signal"), for funds in the seed
 * Non-destructive: does NOT touch isActive / notes and does NOT deactivate funds
 * absent from the seed (unlike `institutional-seed-funds --replace`). Funds not
 * in the seed keep the schema default tier="signal" and get categorySort from
 * their stored category via a heuristic pass.
 *
 *   npx tsx scripts/institutional-backfill-tier.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { CATEGORY_TIER, WATCHLIST_SEED, type FundCategory } from "../src/server/services/institutional/watchlist";

async function main() {
  const seedByCik = new Map(WATCHLIST_SEED.map((f) => [f.cik, f]));
  const funds = await prisma.institutionalFund.findMany({ select: { id: true, cik: true, name: true, category: true, tier: true } });

  let tiered = 0;
  let sorted = 0;
  let contextCount = 0;
  for (const f of funds) {
    const seed = seedByCik.get(f.cik);
    const categorySort = CATEGORY_TIER[(f.category as FundCategory) ?? "Growth/Quality"] ?? 1;
    const tier = seed?.tier ?? "signal";
    if (tier === "context") contextCount++;
    const changed = seed && seed.tier && f.tier !== tier;
    await prisma.institutionalFund.update({ where: { id: f.id }, data: { categorySort, tier } });
    sorted++;
    if (changed) tiered++;
  }

  const signal = await prisma.institutionalFund.count({ where: { tier: "signal", isActive: true } });
  const context = await prisma.institutionalFund.count({ where: { tier: "context", isActive: true } });
  console.log(`[backfill-tier] updated categorySort on ${sorted} funds, re-tiered ${tiered}. Active: signal=${signal} context=${context} (seed context=${contextCount}).`);
}

main()
  .catch((e) => {
    console.error("[backfill-tier] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
