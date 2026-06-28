/**
 * Engine 1 — Leg B backtest harness (read-only analysis).
 *
 * Leg B (ratings) carries genuine timestamped history, so we can validate the
 * revision-momentum concept on day one. For each backfilled rating-change event
 * we measure the forward EOD return at several horizons, then report the
 * information coefficient and top-minus-bottom quantile spread. This is the
 * evidence that informs the initial leg weighting (Leg A has no history yet, so
 * the composite stays equal-weight until it accrues; this confirms Leg B pulls
 * its weight and flags the better horizon).
 *
 * Requires RatingEvent to be backfilled first:
 *   npx tsx scripts/revision-weekly.ts --backfill
 *
 * Usage:
 *   npx tsx scripts/revision-legb-backtest.ts [limitTickers=300]
 *
 * Writes nothing.
 */
import { prisma } from "../src/infrastructure/db/client";
import { fetchHistoricalEod, fmpPool } from "../src/infrastructure/providers/fmp";
import {
  actionScore,
  forwardReturnAt,
  informationCoefficient,
  quantileSpread,
  type SignalReturnPair,
} from "../src/lib/revision/backtest";

const HORIZONS = [21, 63, 126]; // ~1m, 3m, 6m in trading days

async function main() {
  const limit = Math.max(10, Number(process.argv[2] ?? "") || 300);

  // Universe sample by market cap (where rating events exist).
  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    orderBy: { marketCap: "desc" },
    take: limit,
    select: { ticker: true },
  });
  const tickers = refs.map((r) => r.ticker);
  console.log(`[legb-backtest] sampling ${tickers.length} tickers`);

  const earliest = await prisma.ratingEvent.findFirst({
    orderBy: { eventDate: "asc" },
    select: { eventDate: true },
  });
  if (!earliest) {
    console.error("No RatingEvent rows. Run: npx tsx scripts/revision-weekly.ts --backfill");
    process.exit(1);
  }
  const from = earliest.eventDate.toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const pairsByHorizon = new Map<number, SignalReturnPair[]>(HORIZONS.map((h) => [h, []]));

  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const [events, bars] = await Promise.all([
        prisma.ratingEvent.findMany({
          where: { ticker },
          orderBy: { eventDate: "asc" },
          select: { eventDate: true, action: true },
        }),
        fetchHistoricalEod(ticker, from, to),
      ]);
      if (bars.length === 0) return;
      const dates = bars.map((b) => b.date);
      const closes = bars.map((b) => b.close);
      const idxOnOrAfter = (iso: string): number => {
        let lo = 0;
        let hi = dates.length - 1;
        let ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (dates[mid]! >= iso) {
            ans = mid;
            hi = mid - 1;
          } else lo = mid + 1;
        }
        return ans;
      };
      for (const e of events) {
        const signal = actionScore(e.action);
        if (signal === 0) continue;
        const i = idxOnOrAfter(e.eventDate.toISOString().slice(0, 10));
        if (i < 0) continue;
        for (const h of HORIZONS) {
          const fwd = forwardReturnAt(closes, i, h);
          if (fwd !== null) pairsByHorizon.get(h)!.push({ signal, forwardReturn: fwd });
        }
      }
    },
    { concurrency: 8 },
  );

  console.log("\n=== Leg B revision-momentum backtest ===");
  for (const h of HORIZONS) {
    const pairs = pairsByHorizon.get(h)!;
    const ic = informationCoefficient(pairs);
    const qs = quantileSpread(pairs);
    console.log(
      `horizon ${h}d | n=${pairs.length} | IC=${ic?.toFixed(4) ?? "n/a"} | ` +
        `top=${qs.topMean !== null ? (qs.topMean * 100).toFixed(2) + "%" : "n/a"} ` +
        `bottom=${qs.bottomMean !== null ? (qs.bottomMean * 100).toFixed(2) + "%" : "n/a"} ` +
        `spread=${qs.spread !== null ? (qs.spread * 100).toFixed(2) + "%" : "n/a"}`,
    );
  }
  if (failures.length) console.log(`\n${failures.length} ticker fetch failures (e.g. ${failures[0]?.error}).`);
  console.log(
    "\nInterpretation: a positive IC and positive top-minus-bottom spread confirm that\n" +
      "upgrades lead and downgrades lag returns. Until Leg A history accrues, keep the\n" +
      "composite equal-weight; use the strongest-IC horizon to emphasize Leg B momentum.",
  );
}

main()
  .catch((e) => {
    console.error("[legb-backtest] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
