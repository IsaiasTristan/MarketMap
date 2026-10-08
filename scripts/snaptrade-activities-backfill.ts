/**
 * Sweep SnapTrade transaction history into the BrokerageActivity ledger for
 * every managed account (or a single one via --account=<snaptradeAccountId>).
 *
 * Idempotent: re-runs write zero. Normally you don't need this — the mirror
 * (`syncBrokerageAccount`) sweeps activities on every sync — but it is handy
 * for a one-shot backfill or to force a full re-pull after a code change.
 *
 * Usage:
 *   npx tsx scripts/snaptrade-activities-backfill.ts
 *   npx tsx scripts/snaptrade-activities-backfill.ts --account=<snaptradeAccountId>
 */
import { prisma } from "../src/infrastructure/db/client";
import { snaptradeConfigured } from "../src/infrastructure/config/env";
import { syncAccountActivities } from "../src/server/services/brokerage/snaptrade-activities.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  if (!snaptradeConfigured()) {
    console.error("[activities] SnapTrade not configured.");
    process.exit(2);
  }
  const acct = opt("account");
  const links = await prisma.brokerageAccountLink.findMany({
    where: acct ? { snaptradeAccountId: acct } : {},
    select: { id: true, snaptradeAccountId: true, institutionName: true, accountMask: true },
  });
  if (links.length === 0) {
    console.error("[activities] no managed accounts found.");
    process.exit(3);
  }
  for (const link of links) {
    console.log(
      `[activities] sweeping ${link.institutionName ?? "?"} …${link.accountMask ?? "????"} (${link.snaptradeAccountId})`,
    );
    const r = await syncAccountActivities(link.id);
    console.log("[activities] result:", JSON.stringify(r, null, 2));
  }
}

main()
  .catch((e) => {
    console.error("[snaptrade-activities-backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
