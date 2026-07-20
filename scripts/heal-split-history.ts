/**
 * One-off (re-runnable) split-history repair: finds securities whose stored
 * PriceHistory contains an implausible bar-over-bar adjClose jump — the
 * signature of a split whose retroactive Yahoo re-adjustment we never pulled
 * (e.g. SOXS 1:10 reverse split 2026-07-15 reading as a +974% 1D return) —
 * and rewrites their full adjusted history via ingestSecurityHistory, then
 * stale-marks the market-map caches of every universe holding a healed name.
 *
 * The daily bound is [1/2.5, 2.5]: leveraged ETFs legitimately move ±30% a
 * day, never ±150%, while the smallest real split is 3:2 — so anything
 * outside the band is a data artifact, not a market move.
 *
 * Usage:
 *   npx tsx scripts/heal-split-history.ts          # scan last 30 days
 *   npx tsx scripts/heal-split-history.ts 90       # custom scan window (days)
 *   npx tsx scripts/heal-split-history.ts 30 SOXS  # force-heal tickers too
 *
 * Exit codes: 0 on success (per-ticker failures logged in the summary),
 * 1 on hard failure.
 */
import { prisma } from "../src/infrastructure/db/client";
import { ingestSecurityHistory } from "../src/server/services/price-ingest.service";
import { invalidateMarketMapCache } from "../src/server/services/market-map-cache.service";

const MAX_PLAUSIBLE_DAILY_RATIO = 2.5;

async function main() {
  const scanDays = Math.max(1, Number(process.argv[2] ?? "") || 30);
  const forced = process.argv.slice(3).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const startedAt = Date.now();
  console.log(`[heal-split] scanning last ${scanDays} days for adjClose jumps outside [1/${MAX_PLAUSIBLE_DAILY_RATIO}, ${MAX_PLAUSIBLE_DAILY_RATIO}]…`);

  const suspects = await prisma.$queryRaw<Array<{ ticker: string; tradeDate: Date; ratio: number }>>`
    WITH bars AS (
      SELECT ph."securityId",
             ph."tradeDate",
             ph."adjClose"::float8 AS adj,
             LAG(ph."adjClose"::float8) OVER (
               PARTITION BY ph."securityId" ORDER BY ph."tradeDate"
             ) AS prev
      FROM "PriceHistory" ph
      WHERE ph."tradeDate" >= ${new Date(Date.now() - (scanDays + 5) * 86_400_000)}
    )
    SELECT s.ticker, b."tradeDate", b.adj / b.prev AS ratio
    FROM bars b
    JOIN "Security" s ON s.id = b."securityId"
    WHERE s."isActive"
      AND b.prev > 0
      AND (b.adj / b.prev > ${MAX_PLAUSIBLE_DAILY_RATIO}
        OR b.adj / b.prev < ${1 / MAX_PLAUSIBLE_DAILY_RATIO})
    ORDER BY s.ticker, b."tradeDate"
  `;

  for (const row of suspects) {
    console.log(
      `[heal-split] suspect ${row.ticker} @ ${row.tradeDate.toISOString().slice(0, 10)}: x${row.ratio.toFixed(3)}`
    );
  }

  const tickers = [...new Set([...suspects.map((r) => r.ticker), ...forced])].sort();
  if (tickers.length === 0) {
    console.log("[heal-split] no suspect jumps found; nothing to heal.");
    return;
  }
  console.log(`[heal-split] healing ${tickers.length} ticker(s): ${tickers.join(", ")}`);

  const healed: string[] = [];
  const failures: string[] = [];
  for (const ticker of tickers) {
    try {
      const outcome = await ingestSecurityHistory(prisma, ticker);
      if (outcome.kind === "ok") {
        console.log(`[heal-split] ${ticker}: rewrote ${outcome.bars} bars`);
        healed.push(ticker);
      } else {
        failures.push(`${ticker} — ${outcome.kind}`);
      }
    } catch (e) {
      failures.push(`${ticker} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (healed.length > 0) {
    const constituents = await prisma.universeConstituent.findMany({
      where: { security: { ticker: { in: healed } } },
      select: { universeId: true },
      distinct: ["universeId"],
    });
    for (const c of constituents) {
      await invalidateMarketMapCache(c.universeId);
    }
    console.log(`[heal-split] stale-marked market-map caches for ${constituents.length} universe(s).`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[heal-split] done in ${elapsed}s. healed=${healed.length}, failures=${failures.length}`);
  for (const line of failures) console.log(`  ${line}`);
}

main()
  .catch((e) => {
    console.error("[heal-split] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
