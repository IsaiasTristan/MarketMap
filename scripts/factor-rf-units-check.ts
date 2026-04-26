/**
 * One-shot: print raw FactorReturnDaily.value entries for RF and a few
 * other factors so we can read the actual stored units. The reconciliation
 * script suggests RF cumulative ~ 0% over 1Y, which means either (a) the
 * stored values are already daily and the service's `/ 252` is wrong, or
 * (b) the stored values are micro-rates (e.g. 0.044 / 252 was already
 * applied at write time).
 *
 * Read-only.
 *
 * Usage: `npx tsx scripts/factor-rf-units-check.ts`
 */
import { prisma } from "../src/infrastructure/db/client";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  // Pull a small recent window of RF rows.
  const recent = await prisma.factorReturnDaily.findMany({
    where: { factorCode: "RF" },
    orderBy: { tradeDate: "desc" },
    take: 10,
    select: { tradeDate: true, value: true, source: true },
  });
  console.log(`[units] RF — most recent 10 rows (raw stored value):`);
  for (const r of recent) {
    console.log(
      `  ${isoDay(r.tradeDate)}  value = ${Number(r.value).toExponential(6)}  (${Number(r.value)})  source=${r.source}`,
    );
  }

  // Also print 10 RF rows from earlier in the year to see if units differ
  // by source (KF Ibbotson vs FRED PROXY).
  const earlier = await prisma.factorReturnDaily.findMany({
    where: { factorCode: "RF", tradeDate: { lte: new Date("2025-06-01") } },
    orderBy: { tradeDate: "desc" },
    take: 10,
    select: { tradeDate: true, value: true, source: true },
  });
  console.log("");
  console.log(`[units] RF — 10 rows from before 2025-06-01:`);
  for (const r of earlier) {
    console.log(
      `  ${isoDay(r.tradeDate)}  value = ${Number(r.value).toExponential(6)}  (${Number(r.value)})  source=${r.source}`,
    );
  }

  // Compare to MOM and EQ which we know are daily simple returns.
  const mom = await prisma.factorReturnDaily.findMany({
    where: { factorCode: "MOM" },
    orderBy: { tradeDate: "desc" },
    take: 5,
    select: { tradeDate: true, value: true, source: true },
  });
  console.log("");
  console.log(`[units] MOM — most recent 5 rows (for unit comparison):`);
  for (const r of mom) {
    console.log(
      `  ${isoDay(r.tradeDate)}  value = ${Number(r.value).toExponential(6)}  (${Number(r.value)})  source=${r.source}`,
    );
  }

  // Aggregate RF stats over the trailing 1Y window.
  const oneYearAgo = new Date();
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  const window = await prisma.factorReturnDaily.findMany({
    where: { factorCode: "RF", tradeDate: { gte: oneYearAgo } },
    select: { value: true },
  });
  const vals = window.map((r) => Number(r.value));
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = vals.length > 0 ? sum / vals.length : 0;
  const max = vals.length > 0 ? Math.max(...vals) : 0;
  const min = vals.length > 0 ? Math.min(...vals) : 0;
  console.log("");
  console.log(`[units] trailing-1Y RF stats over ${vals.length} rows:`);
  console.log(`  mean = ${mean.toExponential(6)}  (${mean})`);
  console.log(`  min  = ${min.toExponential(6)}`);
  console.log(`  max  = ${max.toExponential(6)}`);
  console.log(`  sum  = ${sum.toExponential(6)}  (${sum})`);
  console.log("");
  console.log(`[units] interpretations:`);
  console.log(`  if stored as ANNUAL decimal (e.g. 0.044 = 4.4%):`);
  console.log(`    daily rate = mean/252 = ${(mean / 252).toExponential(4)}`);
  console.log(`    cumulative ~ exp(252 * ln(1 + ${(mean / 252).toExponential(4)})) - 1 = ${
    (Math.exp(252 * Math.log(1 + mean / 252)) - 1) * 100
  }%`);
  console.log(`  if stored as DAILY decimal already:`);
  console.log(`    cumulative ~ exp(252 * ln(1 + ${mean.toExponential(4)})) - 1 = ${
    (Math.exp(252 * Math.log(1 + mean)) - 1) * 100
  }%`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
