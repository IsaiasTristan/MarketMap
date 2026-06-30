/**
 * Engine 1 - DAILY event tail (CLI entry point).
 *
 * Tails upgrade/downgrade grades + price-target news for the full active
 * universe into RatingEvent / PriceTargetEvent. Idempotent (dedupe by unique
 * constraint), so it is safe to run repeatedly. Mirrors the in-app revision
 * runner's daily path; provided for manual runs / parity. The weekly consensus
 * snapshot is a separate job (npm run job:revision).
 *
 * Usage:
 *   npx tsx scripts/revision-daily.ts
 *
 * Exit 0 on success, 1 on fatal error.
 */
import { prisma } from "../src/infrastructure/db/client";
import { runRevisionDailyEvents } from "../src/server/services/revision/revision-daily-events.service";

async function main() {
  const log = (msg: string) => console.log(msg);
  const summary = await runRevisionDailyEvents({ log });
  console.log("[revision-daily] summary:", JSON.stringify(summary, null, 2));
}

main()
  .catch((e) => {
    console.error("[revision-daily] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
