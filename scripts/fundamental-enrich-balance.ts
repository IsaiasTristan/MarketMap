/**
 * Engine 2 — one-shot additive enrichment for the FA (Financials) view.
 *
 * Captures balance-sheet Preferred Equity + Minority Interest onto existing
 * FundamentalPeriod rows that predate those columns. This is NOT a restatement:
 * the two fields were simply never mapped before, so populating them where they
 * are currently null is purely additive and leaves every as-first-reported
 * figure untouched (write-once integrity preserved for existing data).
 *
 * Idempotent: only rows where both new columns are null are touched, and FMP's
 * value (often 0, meaning "no preferred / no minority") is written once. Routine
 * weekly ingestion writes both fields for all new rows going forward.
 *
 * Usage:
 *   npx tsx scripts/fundamental-enrich-balance.ts            # whole stored universe
 *   npx tsx scripts/fundamental-enrich-balance.ts --limit=25 # staged / smoke run
 */
import { prisma } from "../src/infrastructure/db/client";
import { fetchBalanceSheet, fmpPool, isoDate, num } from "../src/infrastructure/providers/fmp";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const limit = opt("limit");

  // Distinct tickers that still have at least one un-enriched quarterly row.
  const pending = await prisma.fundamentalPeriod.findMany({
    where: {
      periodType: "quarter",
      OR: [{ preferredEquity: null }, { minorityInterest: null }],
    },
    select: { ticker: true },
    distinct: ["ticker"],
    orderBy: { ticker: "asc" },
  });
  let tickers = pending.map((p) => p.ticker);
  if (limit) tickers = tickers.slice(0, Number(limit));
  console.log(`[fund-enrich] ${tickers.length} tickers with rows to enrich`);
  if (tickers.length === 0) {
    console.log("[fund-enrich] nothing to do.");
    return;
  }

  let rowsUpdated = 0;

  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const rows = await prisma.fundamentalPeriod.findMany({
        where: {
          ticker,
          periodType: "quarter",
          OR: [{ preferredEquity: null }, { minorityInterest: null }],
        },
        select: { id: true, fiscalDate: true },
      });
      if (rows.length === 0) return;

      const balance = await fetchBalanceSheet(ticker, "quarter", 40);
      const byDate = new Map<string, { preferred: number | null; minority: number | null }>();
      for (const b of balance) {
        const d = isoDate(b.date);
        if (d) byDate.set(d, { preferred: num(b.preferredStock), minority: num(b.minorityInterest) });
      }

      for (const r of rows) {
        const d = r.fiscalDate.toISOString().slice(0, 10);
        const hit = byDate.get(d);
        if (!hit) continue;
        await prisma.fundamentalPeriod.update({
          where: { id: r.id },
          data: { preferredEquity: hit.preferred, minorityInterest: hit.minority },
        });
        rowsUpdated++;
      }
    },
    { concurrency: 6 },
  );

  console.log(`[fund-enrich] rows updated: ${rowsUpdated}; failures: ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.item}: ${f.error}`);
}

main()
  .catch((e) => {
    console.error("[fund-enrich] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
