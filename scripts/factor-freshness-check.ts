/**
 * One-shot diagnostic: print the latest tradeDate per factorCode in
 * FactorReturnDaily so we can verify the pipeline-refresh splice has populated
 * recent dates for all MACRO14 codes. Also hits the timeseries API for a
 * sample ticker to confirm `factorDataStale` is plumbed through end-to-end.
 *
 * Read-only.
 *
 * Usage: `npx tsx scripts/factor-freshness-check.ts [TICKER]`
 *   defaults to INTC, override via positional arg.
 */
import { prisma } from "../src/infrastructure/db/client";

async function main() {
  const ticker = (process.argv[2] ?? "INTC").toUpperCase();
  const port = process.env.PORT ?? "3001";

  const rows = await prisma.$queryRawUnsafe<Array<{ factorCode: string; last_date: Date; rows: bigint }>>(
    `SELECT "factorCode", MAX("tradeDate") AS last_date, COUNT(*) AS rows
     FROM "FactorReturnDaily"
     GROUP BY "factorCode"
     ORDER BY "factorCode"`,
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  function tradingDayLag(last: Date): number {
    let count = 0;
    const cur = new Date(last);
    cur.setUTCDate(cur.getUTCDate() + 1);
    while (cur <= today) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) count++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return count;
  }

  console.log("DB rows by factor:");
  console.log("factorCode      | last_date    | rows     | trading_day_lag");
  console.log("----------------+--------------+----------+----------------");
  for (const r of rows) {
    const lastIso = r.last_date.toISOString().slice(0, 10);
    const lag = tradingDayLag(r.last_date);
    const flag = lag > 3 ? "  STALE" : "";
    console.log(
      `${r.factorCode.padEnd(15)} | ${lastIso}   | ${String(r.rows).padStart(8)} | ${String(lag).padStart(15)}${flag}`,
    );
  }

  const url = `http://localhost:${port}/api/analysis/factors/per-stock/timeseries?ticker=${ticker}&model=MACRO14&window=252&rollingWindow=60`;
  console.log(`\nGET ${url}`);
  try {
    const res = await fetch(url);
    if (res.ok) {
      const j = (await res.json()) as {
        windowUsed: number;
        displayStartIndex: number;
        dates: string[];
        factorDataStale?: Array<{
          factor: string;
          lastDate: string;
          referenceDate: string;
          lagTradingDays: number;
        }>;
      };
      const visible = j.windowUsed - j.displayStartIndex;
      console.log(`  windowUsed=${j.windowUsed} visible_obs=${visible}`);
      console.log(`  date range: ${j.dates?.[j.displayStartIndex]} -> ${j.dates?.[j.dates.length - 1]}`);
      const stale = j.factorDataStale ?? [];
      console.log(`  factorDataStale: ${stale.length} entries`);
      for (const s of stale) {
        console.log(`    ${s.factor.padEnd(10)} last=${s.lastDate}  ref=${s.referenceDate}  lag=${s.lagTradingDays}d`);
      }
    } else {
      console.log(`  HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  (dev server not reachable: ${(e as Error).message})`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
