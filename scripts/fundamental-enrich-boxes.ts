/**
 * Engine 2 — one-shot additive enrichment for the multi-box discovery model.
 *
 * Populates the FundamentalPeriod columns added for the new boxes (interest
 * expense, stock-based comp, change in working capital, common stock issued /
 * repurchased, dividend yield, FCF yield, interest coverage) on existing rows
 * that predate those columns, and backfills EarningsSurprise rows. This is NOT
 * a restatement: the fields were never mapped before, so writing them where they
 * are currently null is purely additive — every as-first-reported figure is
 * left untouched (write-once integrity preserved). Routine weekly ingestion
 * writes all fields for new rows going forward.
 *
 * Idempotent: each column is written only where currently null, and earnings
 * surprises are inserted skip-duplicates.
 *
 * Usage:
 *   npx tsx scripts/fundamental-enrich-boxes.ts                 # whole stored universe (period cols + earnings)
 *   npx tsx scripts/fundamental-enrich-boxes.ts --limit=25      # staged / smoke run
 *   npx tsx scripts/fundamental-enrich-boxes.ts --earnings-only # only backfill EarningsSurprise (1 FMP call/ticker)
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  fetchKeyMetrics,
  fetchRatios,
  fetchStatementPeriods,
  fmpPool,
} from "../src/infrastructure/providers/fmp";
import { persistEarningsSurprises } from "../src/server/services/fundamental/fundamental-earnings.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fast path: only backfill EarningsSurprise (Box 2 + the residual-since-earnings
 * component). One FMP /stable/earnings call per ticker, idempotent skip-duplicates.
 * Used for the universe-wide re-backfill once the period columns are already
 * populated by routine ingestion.
 */
async function earningsOnly(snapshotDate: string, limit?: string) {
  const distinct = await prisma.fundamentalPeriod.findMany({
    where: { periodType: "quarter" },
    select: { ticker: true },
    distinct: ["ticker"],
    orderBy: { ticker: "asc" },
  });
  let tickers = distinct.map((d) => d.ticker);
  if (limit) tickers = tickers.slice(0, Number(limit));
  console.log(`[fund-enrich-boxes] earnings-only: ${tickers.length} tickers`);
  if (tickers.length === 0) return;

  let inserted = 0;
  let done = 0;
  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      inserted += await persistEarningsSurprises(ticker, snapshotDate);
      if (++done % 200 === 0) console.log(`[fund-enrich-boxes]   ${done}/${tickers.length} processed`);
    },
    { concurrency: 8 },
  );
  console.log(`[fund-enrich-boxes] earnings surprises inserted: ${inserted}; failures: ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.item}: ${f.error}`);
}

async function main() {
  const limit = opt("limit");
  const snapshotDate = opt("date") ?? todayIso();

  if (flag("earnings-only")) {
    await earningsOnly(snapshotDate, limit);
    return;
  }

  const pending = await prisma.fundamentalPeriod.findMany({
    where: {
      periodType: "quarter",
      OR: [
        { interestExpense: null },
        { stockBasedCompensation: null },
        { changeInWorkingCapital: null },
        { commonStockIssued: null },
        { commonStockRepurchased: null },
        { dividendYield: null },
        { fcfYield: null },
        { interestCoverage: null },
      ],
    },
    select: { ticker: true },
    distinct: ["ticker"],
    orderBy: { ticker: "asc" },
  });
  let tickers = pending.map((p) => p.ticker);
  if (limit) tickers = tickers.slice(0, Number(limit));
  console.log(`[fund-enrich-boxes] ${tickers.length} tickers with rows to enrich`);
  if (tickers.length === 0) {
    console.log("[fund-enrich-boxes] nothing to do.");
    return;
  }

  let rowsUpdated = 0;
  let surprisesInserted = 0;

  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const rows = await prisma.fundamentalPeriod.findMany({
        where: { ticker, periodType: "quarter" },
        select: {
          id: true,
          fiscalDate: true,
          interestExpense: true,
          stockBasedCompensation: true,
          changeInWorkingCapital: true,
          commonStockIssued: true,
          commonStockRepurchased: true,
          dividendYield: true,
          fcfYield: true,
          interestCoverage: true,
        },
      });

      const [statements, ratios, keyMetrics] = await Promise.all([
        fetchStatementPeriods(ticker, "quarter", 40),
        fetchRatios(ticker, "quarter", 40),
        fetchKeyMetrics(ticker, "quarter", 40),
      ]);
      const stmtByDate = new Map(statements.map((s) => [s.fiscalDate, s]));
      const ratiosByDate = new Map(ratios.map((r) => [r.fiscalDate, r]));
      const kmByDate = new Map(keyMetrics.map((k) => [k.fiscalDate, k]));

      for (const r of rows) {
        const d = r.fiscalDate.toISOString().slice(0, 10);
        const s = stmtByDate.get(d);
        const ra = ratiosByDate.get(d);
        const km = kmByDate.get(d);
        const data: Record<string, number | null> = {};
        // Only write columns that are currently null (additive, idempotent).
        if (r.interestExpense === null && s?.interestExpense != null) data.interestExpense = s.interestExpense;
        if (r.stockBasedCompensation === null && s?.stockBasedCompensation != null) data.stockBasedCompensation = s.stockBasedCompensation;
        if (r.changeInWorkingCapital === null && s?.changeInWorkingCapital != null) data.changeInWorkingCapital = s.changeInWorkingCapital;
        if (r.commonStockIssued === null && s?.commonStockIssued != null) data.commonStockIssued = s.commonStockIssued;
        if (r.commonStockRepurchased === null && s?.commonStockRepurchased != null) data.commonStockRepurchased = s.commonStockRepurchased;
        if (r.dividendYield === null && ra?.dividendYield != null) data.dividendYield = ra.dividendYield;
        if (r.interestCoverage === null && ra?.interestCoverage != null) data.interestCoverage = ra.interestCoverage;
        if (r.fcfYield === null && km?.fcfYield != null) data.fcfYield = km.fcfYield;
        if (Object.keys(data).length === 0) continue;
        await prisma.fundamentalPeriod.update({ where: { id: r.id }, data });
        rowsUpdated++;
      }

      surprisesInserted += await persistEarningsSurprises(ticker, snapshotDate);
    },
    { concurrency: 6 },
  );

  console.log(
    `[fund-enrich-boxes] period rows updated: ${rowsUpdated}; earnings surprises inserted: ${surprisesInserted}; failures: ${failures.length}`,
  );
  for (const f of failures.slice(0, 10)) console.log(`  ${f.item}: ${f.error}`);
}

main()
  .catch((e) => {
    console.error("[fund-enrich-boxes] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
