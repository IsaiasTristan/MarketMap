/**
 * Engine 3 — seed / refresh the fund watchlist from WATCHLIST_SEED.
 *
 * Upserts by CIK: creates new funds, updates name/edgarName/category/tier/
 * isMostRespected on existing ones. `isActive` and `notes` are preserved on
 * existing rows (user-controlled) unless --replace is passed.
 *
 * --replace  Treat WATCHLIST_SEED as the complete curated universe: funds in
 *            the DB but not in the seed are deactivated (or deleted outright
 *            when they have no ingested snapshots), and seed notes overwrite
 *            DB notes. Use when swapping in a new universe file.
 *
 *   npx tsx scripts/institutional-seed-funds.ts [--replace]
 */
import { prisma } from "../src/infrastructure/db/client";
import { CATEGORY_TIER, WATCHLIST_SEED } from "../src/server/services/institutional/watchlist";

async function main() {
  const replace = process.argv.includes("--replace");
  let created = 0;
  let updated = 0;
  let retiered = 0;
  for (const f of WATCHLIST_SEED) {
    const existing = await prisma.institutionalFund.findUnique({ where: { cik: f.cik } });
    const tier = f.tier ?? "signal";
    const common = {
      name: f.name,
      edgarName: f.edgarName,
      category: f.category,
      tier,
      categorySort: CATEGORY_TIER[f.category],
      isMostRespected: f.isMostRespected ?? false,
    };
    // Tier is user-editable and the DB is the source of truth after seeding, so a
    // plain re-seed PRESERVES the DB tier; only --replace re-asserts the seed tier.
    // Re-tiering is global — log every change so a full metrics recompute
    // (job:institutional --aggregate-only) can be triggered downstream.
    if (existing && replace && existing.tier !== tier) {
      retiered++;
      await prisma.dataQualityEvent.create({
        data: {
          kind: "tier_change",
          fundId: existing.id,
          payload: { cik: f.cik, name: f.name, from: existing.tier, to: tier, actor: "seed --replace" },
        },
      });
    }
    const { tier: _seedTier, ...commonNoTier } = common;
    await prisma.institutionalFund.upsert({
      where: { cik: f.cik },
      create: { cik: f.cik, ...common, notes: f.notes ?? null },
      update: replace ? { ...common, notes: f.notes ?? null, isActive: true } : commonNoTier,
    });
    if (existing) updated++;
    else created++;
  }

  let deactivated = 0;
  let deleted = 0;
  if (replace) {
    const seedCiks = new Set(WATCHLIST_SEED.map((f) => f.cik));
    const stale = await prisma.institutionalFund.findMany({
      where: { cik: { notIn: [...seedCiks] } },
      include: { _count: { select: { holdings: true, books: true } } },
    });
    for (const f of stale) {
      if (f._count.holdings === 0 && f._count.books === 0) {
        await prisma.institutionalFund.delete({ where: { id: f.id } });
        deleted++;
        console.log(`[institutional-seed] deleted ${f.name} (${f.cik}) — not in seed, no ingested data`);
      } else if (f.isActive) {
        await prisma.institutionalFund.update({
          where: { id: f.id },
          data: { isActive: false, notes: `${f.notes ? `${f.notes} ` : ""}Deactivated ${new Date().toISOString().slice(0, 10)}: removed from curated universe.` },
        });
        deactivated++;
        console.log(`[institutional-seed] deactivated ${f.name} (${f.cik}) — not in seed, history retained`);
      }
    }
  }

  const total = await prisma.institutionalFund.count();
  const active = await prisma.institutionalFund.count({ where: { isActive: true } });
  const signal = await prisma.institutionalFund.count({ where: { isActive: true, tier: "signal" } });
  const context = await prisma.institutionalFund.count({ where: { isActive: true, tier: "context" } });
  console.log(`[institutional-seed] created=${created} updated=${updated} retiered=${retiered} deactivated=${deactivated} deleted=${deleted} total=${total} active=${active} signal=${signal} context=${context}`);
}

main()
  .catch((e) => {
    console.error("[institutional-seed] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
