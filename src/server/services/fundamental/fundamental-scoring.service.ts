/**
 * Engine 2 — signal + scoring layer. Reads each ticker's FULL trailing
 * FundamentalPeriod history (so the discovery screen is populated on day one
 * from the backfill — not waiting for forward weeks), computes the inflection /
 * quality / valuation signals, z-scores the cross-sectional inflection signals
 * peer-relative (subsector-first, sector fallback — reusing Engine 1's
 * primitives), and writes FundamentalScore + FundamentalSectorAggregate +
 * DiscoveryQueueSnapshot.
 *
 * The valuation-vs-own-history signal is intra-ticker (percentile, NOT z-scored)
 * and is kept out of the cross-sectional composite by design. Quality filters
 * set trapFlag / compounderScore. Distinct from ingestion so signal definitions
 * can change without touching the store.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  INFLECTION_SIGNALS,
  computeInflectionSignals,
  type InflectionSignals,
} from "@/lib/fundamental/inflection";
import { accrualsDivergence, compounder, trapFlag } from "@/lib/fundamental/quality";
import { valuationPercentiles } from "@/lib/fundamental/valuation";
import { buildMetricSeries, lastFinite, type PeriodFacts } from "@/lib/fundamental/series";
import { compositeScores, isNewArrival, rankAndDecile, zScores } from "@/lib/revision/scoring";
import { resolvePeerGroups, rollupGroups, type RefClassification } from "@/lib/revision/aggregate";

export interface FundamentalScoreOptions {
  snapshotDate?: string;
  weights?: Record<string, number>;
  log?: (msg: string) => void;
}

export interface FundamentalScoreSummary {
  snapshotDate: string;
  priorSnapshotDate: string | null;
  scored: number;
  newArrivals: number;
  traps: number;
  sectorGroups: number;
  subsectorGroups: number;
}

type PeriodRow = Prisma.FundamentalPeriodGetPayload<{}>;
type SnapshotRow = Prisma.FundamentalSnapshotGetPayload<{}>;

function dec(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rowToFacts(p: PeriodRow): PeriodFacts {
  return {
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
}

/** Underlying 8-quarter sparkline series per inflection column (oldest -> newest). */
interface InflectionSparkSeries {
  grossMargin: number[];
  ebitdaMargin: number[];
  revenueGrowth: number[];
  fcf: number[];
  roic: number[];
  netDebtToEbitda: number[];
}

interface StockSignals {
  inflection: InflectionSignals;
  compounderScore: number | null;
  compounderLevel: number | null;
  compounderConsistency: number | null;
  accrualsDivergence: number | null;
  accrualsRatio: number | null;
  trap: boolean;
  cheapness: number | null;
  valuationDetail: { peRatio: number | null; evToEbitda: number | null; priceToSales: number | null };
  /** EBITDA-margin now vs ~8 quarters ago — drives the inflection dumbbell. */
  marginNow: number | null;
  marginPrior: number | null;
  /** The actual data each inflection consumes, last 8 finite points, for sparklines. */
  series: InflectionSparkSeries;
}

/** Finite value ~`back` positions before the last finite entry (for the dumbbell). */
function finiteBack(series: Array<number | null>, back = 8): number | null {
  const idxs: number[] = [];
  series.forEach((v, i) => {
    if (v !== null && v !== undefined && Number.isFinite(v)) idxs.push(i);
  });
  if (idxs.length === 0) return null;
  const target = idxs[Math.max(0, idxs.length - 1 - back)]!;
  return series[target] ?? null;
}

/** Last up-to-`n` finite values of a possibly-sparse series, in order. */
function last8Finite(series: Array<number | null>, n = 8): number[] {
  const finite = series.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  return finite.slice(-n);
}

function computeStockSignals(periods: PeriodFacts[], snap: SnapshotRow | undefined): StockSignals {
  const series = buildMetricSeries(periods);
  const inflection = computeInflectionSignals({
    grossMargin: series.ttmGrossMargin,
    ebitdaMargin: series.ttmEbitdaMargin,
    revenueGrowthYoy: series.revenueGrowthYoy,
    fcf: series.ttmFcf,
    roic: series.roic,
    netDebtToEbitda: series.netDebtToEbitda,
  });
  const comp = compounder(series.roic);
  const divergence = accrualsDivergence(series.netIncome, series.operatingCashFlow);
  const accruals = snap?.accrualsRatio ?? null;
  const trap = trapFlag({ accrualsRatio: accruals, accrualsDivergence: divergence });

  const current = {
    peRatio: snap?.peRatio !== undefined ? dec(snap.peRatio) : null,
    evToEbitda: snap?.evToEbitda !== undefined ? dec(snap.evToEbitda) : null,
    priceToSales: snap?.priceToSales !== undefined ? dec(snap.priceToSales) : null,
  };
  const val = valuationPercentiles(current, {
    peRatio: series.peRatio,
    evToEbitda: series.evToEbitda,
    priceToSales: series.priceToSales,
  });

  return {
    inflection,
    compounderScore: comp.score,
    compounderLevel: comp.level,
    compounderConsistency: comp.consistency,
    accrualsDivergence: divergence,
    accrualsRatio: accruals,
    trap,
    cheapness: val.cheapness,
    valuationDetail: { peRatio: val.peRatio, evToEbitda: val.evToEbitda, priceToSales: val.priceToSales },
    marginNow: lastFinite(series.ttmEbitdaMargin),
    marginPrior: finiteBack(series.ttmEbitdaMargin, 8),
    series: {
      grossMargin: last8Finite(series.ttmGrossMargin),
      ebitdaMargin: last8Finite(series.ttmEbitdaMargin),
      revenueGrowth: last8Finite(series.revenueGrowthYoy),
      fcf: last8Finite(series.ttmFcf),
      roic: last8Finite(series.roic),
      netDebtToEbitda: last8Finite(series.netDebtToEbitda),
    },
  };
}

function decilesWithinGroups(
  composites: Array<number | null>,
  groupKeys: string[],
): Array<number | null> {
  const out: Array<number | null> = new Array(composites.length).fill(null);
  const byGroup = new Map<string, number[]>();
  groupKeys.forEach((k, i) => {
    const arr = byGroup.get(k);
    if (arr) arr.push(i);
    else byGroup.set(k, [i]);
  });
  for (const idxs of byGroup.values()) {
    const sub = idxs.map((i) => composites[i] ?? null);
    for (const e of rankAndDecile(sub)) out[idxs[e.index]!] = e.decile;
  }
  return out;
}

export async function scoreFundamentalWeek(
  opts: FundamentalScoreOptions = {},
): Promise<FundamentalScoreSummary> {
  const log = opts.log ?? (() => {});

  const latest = opts.snapshotDate
    ? new Date(`${opts.snapshotDate}T00:00:00Z`)
    : (
        await prisma.fundamentalSnapshot.findFirst({
          orderBy: { snapshotDate: "desc" },
          select: { snapshotDate: true },
        })
      )?.snapshotDate ?? null;
  if (!latest) {
    log("[fund-scoring] no snapshots present");
    return { snapshotDate: "", priorSnapshotDate: null, scored: 0, newArrivals: 0, traps: 0, sectorGroups: 0, subsectorGroups: 0 };
  }
  const snapshotIso = isoOf(latest);

  const snapshots = await prisma.fundamentalSnapshot.findMany({ where: { snapshotDate: latest } });
  const snapByTicker = new Map(snapshots.map((s) => [s.ticker, s]));
  const tickers = snapshots.map((s) => s.ticker);
  if (tickers.length === 0) {
    log("[fund-scoring] snapshot date has no rows");
    return { snapshotDate: snapshotIso, priorSnapshotDate: null, scored: 0, newArrivals: 0, traps: 0, sectorGroups: 0, subsectorGroups: 0 };
  }

  // Full trailing fiscal-period history per ticker (day-one population).
  const periodRows = await prisma.fundamentalPeriod.findMany({
    where: { ticker: { in: tickers }, periodType: "quarter" },
    orderBy: [{ ticker: "asc" }, { fiscalDate: "asc" }],
  });
  const periodsByTicker = new Map<string, PeriodFacts[]>();
  for (const r of periodRows) {
    const arr = periodsByTicker.get(r.ticker) ?? [];
    arr.push(rowToFacts(r));
    periodsByTicker.set(r.ticker, arr);
  }

  const refs = await prisma.revisionReference.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, sector: true, subsector: true, companyName: true },
  });
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));

  const stocks = tickers.map((ticker) => ({
    ticker,
    signals: computeStockSignals(periodsByTicker.get(ticker) ?? [], snapByTicker.get(ticker)),
  }));

  // Peer groups (subsector-first, sector fallback) — Engine 1 convention.
  const classifications: RefClassification[] = stocks.map((s) => ({
    ticker: s.ticker,
    sector: refByTicker.get(s.ticker)?.sector ?? null,
    subsector: refByTicker.get(s.ticker)?.subsector ?? null,
  }));
  const peers = resolvePeerGroups(classifications);
  const peerKey = (i: number) => peers.get(stocks[i]!.ticker)!.peerGroupKey;

  // Z-score each inflection signal WITHIN its peer group.
  const zBySignal: Array<{ key: string; z: Map<number, number> }> = [];
  const buckets = new Map<string, number[]>();
  stocks.forEach((_, i) => {
    const k = peerKey(i);
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });
  for (const sig of INFLECTION_SIGNALS) {
    const global = new Map<number, number>();
    for (const idxs of buckets.values()) {
      const sub = idxs.map((i) => (stocks[i]!.signals.inflection[sig] as number | null) ?? null);
      const { z } = zScores(sub);
      for (const [localIdx, zv] of z) global.set(idxs[localIdx]!, zv);
    }
    zBySignal.push({ key: sig as string, z: global });
  }

  const composites = compositeScores(zBySignal, stocks.length, opts.weights);

  const ranked = rankAndDecile(composites);
  const globalRank = new Map<number, number>();
  for (const e of ranked) globalRank.set(e.index, e.rank);

  const sectorKeys = classifications.map((c) => c.sector ?? "Unclassified");
  const subsectorKeys = classifications.map((c) => c.subsector ?? c.sector ?? "Unclassified");
  const sectorDeciles = decilesWithinGroups(composites, sectorKeys);
  const subsectorDeciles = decilesWithinGroups(composites, subsectorKeys);

  // Prior-week deciles for new-arrival detection.
  const priorDateRow = await prisma.fundamentalScore.findFirst({
    where: { snapshotDate: { lt: latest } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const priorDate = priorDateRow?.snapshotDate ?? null;
  const priorScores = priorDate
    ? await prisma.fundamentalScore.findMany({
        where: { snapshotDate: priorDate },
        select: { ticker: true, subsectorDecile: true, sectorDecile: true },
      })
    : [];
  const priorDecileByTicker = new Map(
    priorScores.map((p) => [p.ticker, p.subsectorDecile ?? p.sectorDecile ?? null]),
  );

  let scored = 0;
  let newArrivals = 0;
  let traps = 0;
  const queueRows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i]!;
    const peer = peers.get(s.ticker)!;
    const composite = composites[i] ?? null;
    const subDecile = subsectorDeciles[i] ?? null;
    const secDecile = sectorDeciles[i] ?? null;
    const primaryDecile = peer.peerGroupType === "SUBSECTOR" ? subDecile : secDecile;
    const newArrival = isNewArrival(primaryDecile, priorDecileByTicker.get(s.ticker) ?? null);
    if (newArrival) newArrivals++;
    if (s.signals.trap) traps++;

    const z = Object.fromEntries(zBySignal.map((zs) => [zs.key, zs.z.get(i) ?? null]));
    const ref = refByTicker.get(s.ticker);
    const scoreJson = {
      inflection: s.signals.inflection,
      z,
      series: s.signals.series,
      compounder: {
        score: s.signals.compounderScore,
        level: s.signals.compounderLevel,
        consistency: s.signals.compounderConsistency,
      },
      accruals: { ratio: s.signals.accrualsRatio, divergence: s.signals.accrualsDivergence },
      valuation: { cheapness: s.signals.cheapness, ...s.signals.valuationDetail },
      peerGroup: peer,
    } as unknown as Prisma.InputJsonValue;

    try {
      const data = {
        peerGroupType: peer.peerGroupType,
        peerGroupKey: peer.peerGroupKey,
        composite,
        subsectorDecile: subDecile,
        sectorDecile: secDecile,
        rank: globalRank.get(i) ?? null,
        newArrival,
        trapFlag: s.signals.trap,
        compounderScore: s.signals.compounderScore,
        valuationPercentile: s.signals.cheapness,
        scoreJson,
      };
      await prisma.fundamentalScore.upsert({
        where: { ticker_snapshotDate: { ticker: s.ticker, snapshotDate: latest } },
        create: { ticker: s.ticker, snapshotDate: latest, ...data },
        update: data,
      });
      scored++;
    } catch (e) {
      log(`[fund-scoring] ${s.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }

    queueRows.push({
      ticker: s.ticker,
      companyName: ref?.companyName ?? s.ticker,
      sector: ref?.sector ?? null,
      subsector: ref?.subsector ?? null,
      composite,
      rank: globalRank.get(i) ?? null,
      subsectorDecile: subDecile,
      sectorDecile: secDecile,
      newArrival,
      trapFlag: s.signals.trap,
      compounderScore: s.signals.compounderScore,
      compounderLevel: s.signals.compounderLevel,
      compounderConsistency: s.signals.compounderConsistency,
      cheapness: s.signals.cheapness,
      accrualsDivergence: s.signals.accrualsDivergence,
      marginNow: s.signals.marginNow,
      marginPrior: s.signals.marginPrior,
      inflection: s.signals.inflection,
      series: s.signals.series,
      z,
    });
  }
  queueRows.sort((a, b) => ((b.composite as number) ?? -Infinity) - ((a.composite as number) ?? -Infinity));

  // Sector + subsector aggregates (mean inflection composite + margin-inflection breadth).
  const withScores = stocks.map((s, i) => ({
    ...s,
    composite: composites[i] ?? null,
    marginInflection: s.signals.inflection.ebitdaMarginInflection,
  }));
  const sectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.ticker)?.sector ?? "Unclassified",
    (s) => s.marginInflection,
    (s) => s.composite,
  );
  const subsectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.ticker)?.subsector ?? refByTicker.get(s.ticker)?.sector ?? "Unclassified",
    (s) => s.marginInflection,
    (s) => s.composite,
  );

  for (const [type, rollups] of [
    ["SECTOR", sectorRollups],
    ["SUBSECTOR", subsectorRollups],
  ] as const) {
    for (const g of rollups) {
      await prisma.fundamentalSectorAggregate.upsert({
        where: { groupType_groupKey_snapshotDate: { groupType: type, groupKey: g.groupKey, snapshotDate: latest } },
        create: {
          groupType: type,
          groupKey: g.groupKey,
          snapshotDate: latest,
          marginInflectionMean: g.breadth,
          compositeMean: g.compositeMean,
          nameCount: g.nameCount,
        },
        update: { marginInflectionMean: g.breadth, compositeMean: g.compositeMean, nameCount: g.nameCount },
      });
    }
  }

  await prisma.discoveryQueueSnapshot.upsert({
    where: { snapshotDate: latest },
    create: {
      snapshotDate: latest,
      payloadJson: { snapshotDate: snapshotIso, generatedAt: new Date().toISOString(), count: queueRows.length, rows: queueRows } as Prisma.InputJsonValue,
    },
    update: {
      payloadJson: { snapshotDate: snapshotIso, generatedAt: new Date().toISOString(), count: queueRows.length, rows: queueRows } as Prisma.InputJsonValue,
      computedAt: new Date(),
    },
  });

  log(`[fund-scoring] scored ${scored}, new arrivals ${newArrivals}, traps ${traps}, sectors ${sectorRollups.length}, subsectors ${subsectorRollups.length}`);
  return {
    snapshotDate: snapshotIso,
    priorSnapshotDate: priorDate ? isoOf(priorDate) : null,
    scored,
    newArrivals,
    traps,
    sectorGroups: sectorRollups.length,
    subsectorGroups: subsectorRollups.length,
  };
}
