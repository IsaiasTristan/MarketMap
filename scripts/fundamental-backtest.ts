/**
 * Engine 2 — fundamental-signal backtest harness (read-only, DIRECTIONAL ONLY).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ RESTATEMENT LOOK-AHEAD BIAS — READ THIS BEFORE TRUSTING ANY NUMBER.      │
 * │ The backfilled FundamentalPeriod history is restated-basis: FMP serves the │
 * │ CORRECTED figure, not what was actually known on the filing date. A name   │
 * │ that later restated shows its fixed numbers in the "historical" record it  │
 * │ did not have then. So every result below inherits look-ahead bias and is   │
 * │ DIRECTIONAL, NOT RIGOROUS. Do NOT let a clean-looking IC create false      │
 * │ confidence. Rigorous, leakage-free, survivorship-free fundamentals         │
 * │ backtesting needs a point-in-time vendor (e.g. Sharadar) — that slots into │
 * │ the same schema as a bolt-on, it is not a rebuild. True as-first-reported  │
 * │ history only accrues forward from launch via the weekly LIVE snapshots.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * At each historical quarter-end it computes the cross-sectional inflection
 * composite (z-scored across the sampled names that quarter), pairs it with the
 * forward EOD return, and reports IC + top-minus-bottom quantile spread.
 *
 * Usage:
 *   npx tsx scripts/fundamental-backtest.ts [limitTickers=150]
 * Writes nothing.
 */
import { prisma } from "../src/infrastructure/db/client";
import { fetchHistoricalEod, fmpPool } from "../src/infrastructure/providers/fmp";
import { buildMetricSeries, type PeriodFacts } from "../src/lib/fundamental/series";
import { computeInflectionSignals, INFLECTION_SIGNALS } from "../src/lib/fundamental/inflection";
import { zScores } from "../src/lib/revision/scoring";
import {
  forwardReturnAt,
  informationCoefficient,
  quantileSpread,
  type SignalReturnPair,
} from "../src/lib/revision/backtest";

const HORIZONS = [63, 126, 252]; // ~3m, 6m, 12m in trading days
const MIN_INDEX = 12; // need trailing quarters before a signal is meaningful

function dec(v: { toString(): string } | null): number | null {
  return v === null ? null : Number(v);
}

async function main() {
  const limit = Math.max(10, Number(process.argv[2] ?? "") || 150);

  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    orderBy: { marketCap: "desc" },
    take: limit,
    select: { ticker: true },
  });
  const tickers = refs.map((r) => r.ticker);
  console.log(`[fund-backtest] sampling ${tickers.length} tickers`);
  console.log("⚠ DIRECTIONAL ONLY — results inherit restatement look-ahead bias (see header).\n");

  // Per ticker: build the signal vector at each historical quarter-end.
  type Obs = { ticker: string; date: string; signals: Record<string, number | null> };
  const observations: Obs[] = [];
  const closesByTicker = new Map<string, { dates: string[]; closes: number[] }>();

  const earliest = await prisma.fundamentalPeriod.findFirst({
    orderBy: { fiscalDate: "asc" },
    select: { fiscalDate: true },
  });
  if (!earliest) {
    console.error("No FundamentalPeriod rows. Run: npx tsx scripts/fundamental-weekly.ts --backfill");
    process.exit(1);
  }
  const from = earliest.fiscalDate.toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const [rows, bars] = await Promise.all([
        prisma.fundamentalPeriod.findMany({
          where: { ticker, periodType: "quarter" },
          orderBy: { fiscalDate: "asc" },
        }),
        fetchHistoricalEod(ticker, from, to),
      ]);
      if (rows.length <= MIN_INDEX || bars.length === 0) return;
      closesByTicker.set(ticker, { dates: bars.map((b) => b.date), closes: bars.map((b) => b.close) });

      const facts: PeriodFacts[] = rows.map((p) => ({
        fiscalDate: p.fiscalDate.toISOString().slice(0, 10),
        revenue: dec(p.revenue),
        grossProfit: dec(p.grossProfit),
        operatingIncome: dec(p.operatingIncome),
        netIncome: dec(p.netIncome),
        ebitda: dec(p.ebitda),
        freeCashFlow: dec(p.freeCashFlow),
        operatingCashFlow: dec(p.operatingCashFlow),
        totalDebt: dec(p.totalDebt),
        cash: dec(p.cash),
        totalAssets: dec(p.totalAssets),
        roic: p.roic,
        peRatio: p.peRatio,
        evToEbitda: p.evToEbitda,
        priceToSales: p.priceToSales,
      }));
      const full = buildMetricSeries(facts);
      for (let i = MIN_INDEX; i < facts.length; i++) {
        const sl = <T,>(a: T[]) => a.slice(0, i + 1);
        const sig = computeInflectionSignals({
          grossMargin: sl(full.ttmGrossMargin),
          ebitdaMargin: sl(full.ttmEbitdaMargin),
          revenueGrowthYoy: sl(full.revenueGrowthYoy),
          fcf: sl(full.ttmFcf),
          roic: sl(full.roic),
          netDebtToEbitda: sl(full.netDebtToEbitda),
        });
        observations.push({ ticker, date: facts[i]!.fiscalDate, signals: sig as unknown as Record<string, number | null> });
      }
    },
    { concurrency: 8 },
  );

  // Cross-sectional z per quarter -> composite, paired with forward return.
  const byDate = new Map<string, Obs[]>();
  for (const o of observations) {
    const arr = byDate.get(o.date) ?? [];
    arr.push(o);
    byDate.set(o.date, arr);
  }

  const pairsByHorizon = new Map<number, SignalReturnPair[]>(HORIZONS.map((h) => [h, []]));
  for (const [, group] of byDate) {
    if (group.length < 8) continue; // need a cross-section to z-score
    const zMaps = INFLECTION_SIGNALS.map((s) => {
      const vals = group.map((g) => g.signals[s] ?? null);
      return zScores(vals).z;
    });
    group.forEach((g, idx) => {
      let sum = 0;
      let cnt = 0;
      for (const z of zMaps) {
        const v = z.get(idx);
        if (v !== undefined) { sum += v; cnt++; }
      }
      if (cnt === 0) return;
      const composite = sum / cnt;
      const px = closesByTicker.get(g.ticker);
      if (!px) return;
      // index of first trading day on/after the fiscal date
      let lo = 0, hi = px.dates.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (px.dates[mid]! >= g.date) { at = mid; hi = mid - 1; } else lo = mid + 1;
      }
      if (at < 0) return;
      for (const h of HORIZONS) {
        const fwd = forwardReturnAt(px.closes, at, h);
        if (fwd !== null) pairsByHorizon.get(h)!.push({ signal: composite, forwardReturn: fwd });
      }
    });
  }

  console.log("=== Fundamental inflection-composite backtest (DIRECTIONAL) ===");
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
    "\n⚠ Reminder: restated-basis history => look-ahead bias. Treat a positive IC/spread as\n" +
      "  directional support for the inflection concept, NOT as a tradeable, rigorous result.\n" +
      "  For rigor, bolt on a point-in-time vendor (Sharadar) into the same schema.",
  );
}

main()
  .catch((e) => {
    console.error("[fund-backtest] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
