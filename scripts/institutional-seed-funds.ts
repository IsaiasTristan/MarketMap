/**
 * Engine 3 — seed / refresh the fund watchlist from WATCHLIST_SEED.
 *
 * Upserts by CIK: creates new funds, updates name/edgarName/tier/isMostRespected
 * on existing ones, and NEVER deletes user-added funds. `isActive` and `notes`
 * are preserved on existing rows (user-controlled).
 *
 *   npx tsx scripts/institutional-seed-funds.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { WATCHLIST_SEED } from "../src/server/services/institutional/watchlist";

async function main() {
  let created = 0;
  let updated = 0;
  for (const f of WATCHLIST_SEED) {
    const existing = await prisma.institutionalFund.findUnique({ where: { cik: f.cik } });
    await prisma.institutionalFund.upsert({
      where: { cik: f.cik },
      create: {
        cik: f.cik,
        name: f.name,
        edgarName: f.edgarName,
        tier: f.tier,
        isMostRespected: f.isMostRespected ?? false,
      },
      update: {
        name: f.name,
        edgarName: f.edgarName,
        tier: f.tier,
        isMostRespected: f.isMostRespected ?? false,
      },
    });
    if (existing) updated++;
    else created++;
  }
  const total = await prisma.institutionalFund.count();
  console.log(`[institutional-seed] created=${created} updated=${updated} total=${total}`);
}

main()
  .catch((e) => {
    console.error("[institutional-seed] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
