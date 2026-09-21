/**
 * Pairs tab — Engine 2 quarterly inflection-direction history.
 *
 * Reconstructs each ticker's business-inflection DIRECTION as-of each fiscal
 * quarter end, purely from the write-once FundamentalPeriod statement history
 * (buildMetricSeries -> inflectionFromSeries -> e2Direction). Independent of
 * fundamental-box-scoring.service — Engine 2's weekly job is untouched — because
 * the inflection components need only statements (no prices/estimates/surprises),
 * and ~9 years of quarterly statements are already loaded.
 *
 * RESTATED-BASIS CAVEAT (brief §5.2, correction 2): pre-launch FundamentalPeriod
 * rows are BACKFILL provenance — restated numbers, not as-first-reported — so
 * this reconstruction inherits restatement look-ahead bias. It is directional
 * only, labelled restated-basis, and never a headline. The pairs-group service
 * stamps the group breadth it derives from this with the source quarter, and
 * the whole tab labels Engine 2 breadth "quarterly, restated-basis".
 */
import { prisma } from "@/infrastructure/db/client";
import { buildMetricSeries, type PeriodFacts } from "@/lib/fundamental/series";
import { inflectionFromSeries } from "@/lib/fundamental/box-inputs";
import { e2Direction } from "@/lib/pairs/e2-breadth";
import type { BreadthDirection } from "@/lib/pairs/breadth";

/** Need at least this many quarters before a 4-vs-4 inflection is meaningful. */
const MIN_QUARTERS_FOR_INFLECTION = 8;

export interface E2QuarterDirection {
  /** Fiscal date of the latest quarter included in the reconstruction. */
  quarterEnd: string;
  direction: BreadthDirection;
  /** Finite inflection components available that quarter (data-quality context). */
  componentsAvailable: number;
  /** Net signed vote fraction (positive − negative)/available, in [−1, 1]. Used
   *  by Tier 2 to rank names within a subsector (direction alone is too coarse
   *  to take a top-5); direction/breadth consumers ignore it. */
  magnitude: number;
}

/** ticker -> ascending-by-quarterEnd direction history. */
export type E2DirectionHistory = Map<string, E2QuarterDirection[]>;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dec(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the per-ticker quarterly inflection-direction history for `tickers`.
 * For every quarter with enough lead-in, the series is rebuilt on the periods
 * known AT THAT QUARTER END (restated-basis) and classified up / flat / down.
 */
export async function buildE2DirectionHistory(
  tickers: string[],
  opts: { log?: (m: string) => void } = {},
): Promise<E2DirectionHistory> {
  const out: E2DirectionHistory = new Map();
  if (tickers.length === 0) return out;

  const rows = await prisma.fundamentalPeriod.findMany({
    where: { ticker: { in: tickers }, periodType: "quarter" },
    orderBy: [{ ticker: "asc" }, { fiscalDate: "asc" }],
    select: {
      ticker: true,
      fiscalDate: true,
      revenue: true,
      grossProfit: true,
      operatingIncome: true,
      netIncome: true,
      ebitda: true,
      freeCashFlow: true,
      operatingCashFlow: true,
      totalDebt: true,
      cash: true,
      totalAssets: true,
      roic: true,
      peRatio: true,
      evToEbitda: true,
      priceToSales: true,
    },
  });

  const byTicker = new Map<string, PeriodFacts[]>();
  for (const p of rows) {
    const facts: PeriodFacts = {
      fiscalDate: isoOf(p.fiscalDate),
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
    };
    const arr = byTicker.get(p.ticker);
    if (arr) arr.push(facts);
    else byTicker.set(p.ticker, [facts]);
  }

  let classified = 0;
  for (const [ticker, facts] of byTicker) {
    const history: E2QuarterDirection[] = [];
    for (let i = MIN_QUARTERS_FOR_INFLECTION - 1; i < facts.length; i++) {
      const series = buildMetricSeries(facts.slice(0, i + 1));
      const signals = inflectionFromSeries(series);
      const dir = e2Direction(signals);
      if (dir === null) continue;
      history.push({
        quarterEnd: facts[i]!.fiscalDate,
        direction: dir.direction,
        componentsAvailable: dir.available,
        magnitude: dir.available > 0 ? (dir.positive - dir.negative) / dir.available : 0,
      });
    }
    if (history.length > 0) {
      out.set(ticker, history);
      classified++;
    }
  }
  opts.log?.(`[pairs-e2] reconstructed quarterly direction for ${classified}/${byTicker.size} tickers`);
  return out;
}

/** Latest inflection direction at or before `asOfIso` for a ticker (else null). */
export function e2DirectionAsOf(history: E2DirectionHistory, ticker: string, asOfIso: string): E2QuarterDirection | null {
  const arr = history.get(ticker);
  if (!arr || arr.length === 0) return null;
  let hit: E2QuarterDirection | null = null;
  for (const q of arr) {
    if (q.quarterEnd <= asOfIso) hit = q;
    else break;
  }
  return hit;
}
