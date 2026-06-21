/**
 * One-shot backfill for the multi-user migration.
 *
 *   1. Ensure the admin User row exists (email from ADMIN_EMAILS, role ADMIN).
 *   2. Assign every existing Portfolio with a null userId to the admin, so no
 *      portfolio is orphaned after Portfolio.userId is introduced.
 *
 * Idempotent — safe to re-run. Run once after `npx prisma db push`:
 *   npx tsx scripts/backfill-portfolio-owners.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { adminEmails } from "../src/infrastructure/config/env";

async function main() {
  const admin = adminEmails()[0] ?? "isaiastristan@live.com";
  const user = await prisma.user.upsert({
    where: { email: admin },
    update: { role: "ADMIN" },
    create: { email: admin, role: "ADMIN" },
  });
  const res = await prisma.portfolio.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  console.log(
    `[backfill] admin=${admin} (id=${user.id}); assigned ${res.count} orphan portfolio(s).`,
  );
}

main()
  .catch((e) => {
    console.error("[backfill] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
