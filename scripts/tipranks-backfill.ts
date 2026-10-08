/**
 * Engine 1 — TipRanks (FMP paid add-on) sweep into TipRanksRatingEvent.
 *
 * Usage:
 *   npx tsx scripts/tipranks-backfill.ts                     # full sweep, all tracked tickers (BACKFILL)
 *   npx tsx scripts/tipranks-backfill.ts --resume            # skip tickers already COMPLETE in the ledger
 *   npx tsx scripts/tipranks-backfill.ts --from=2026-10-01   # delta append since a date (LIVE) — the re-subscribe path
 *   npx tsx scripts/tipranks-backfill.ts --tickers=AAPL,MU   # scoped run
 *   npx tsx scripts/tipranks-backfill.ts --analysts          # analyst directory pass only
 *   npx tsx scripts/tipranks-backfill.ts --status            # ledger roll-up only (no FMP calls)
 *
 * Exits non-zero when the add-on is not entitled (HTTP 402) so a scheduled run
 * surfaces the lapse instead of silently writing nothing.
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  sweepTipRanksAnalysts,
  sweepTipRanksRatings,
  tipRanksLedgerStatus,
} from "../src/server/services/revision/tipranks-ingest.service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function printStatus() {
  const s = await tipRanksLedgerStatus();
  console.log("[tipranks] ledger:", JSON.stringify(s, null, 2));
  return s;
}

async function main() {
  const log = (msg: string) => console.log(msg);
  const started = Date.now();

  if (flag("status")) {
    await printStatus();
    return;
  }

  let entitled = true;
  if (!flag("analysts")) {
    const tickers = opt("tickers")
      ?.split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    const summary = await sweepTipRanksRatings({
      tickers,
      from: opt("from"),
      resume: flag("resume"),
      log,
    });
    entitled = summary.entitled;
    console.log("[tipranks] ratings summary:", JSON.stringify({ ...summary, failures: summary.failures.slice(0, 20) }, null, 2));
  }

  if (entitled && (flag("analysts") || flag("with-analysts"))) {
    const a = await sweepTipRanksAnalysts({ log });
    entitled = a.entitled;
    console.log("[tipranks] analysts summary:", JSON.stringify(a, null, 2));
  }

  await printStatus();
  console.log(`[tipranks] elapsed ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (!entitled) {
    console.error("[tipranks] add-on not entitled (HTTP 402) — nothing more can be fetched until re-subscribed");
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error("[tipranks-backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
