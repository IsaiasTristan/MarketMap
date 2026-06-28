/**
 * Engine 1 — signal + scoring layer. Reads the append-only snapshots, computes
 * per-stock revision signals, z-scores them peer-relative (subsector-first,
 * sector fallback), builds the equal-weighted composite + deciles + the
 * week-over-week new-arrival flag, and writes RevisionScore +
 * RevisionSectorAggregate + the ResearchQueueSnapshot output cache.
 *
 * This layer reads the same (ticker, snapshotDate) key ingestion writes but is
 * a distinct service, so signal definitions can change without touching
 * ingestion.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  COMPOSITE_SIGNALS,
  computeRawSignals,
  type BreadthMetric,
  type RatingDist,
  type RawSignals,
  type StockWeek,
} from "@/lib/revision/signals";
import {
  compositeScores,
  isNewArrival,
  rankAndDecile,
  zScores,
} from "@/lib/revision/scoring";
import {
  resolvePeerGroups,
  rollupGroups,
  type RefClassification,
} from "@/lib/revision/aggregate";

export interface ScoreOptions {
  snapshotDate?: string; // defaults to the latest snapshot date present
  weights?: Record<string, number>;
  log?: (msg: string) => void;
}

export interface ScoreSummary {
  snapshotDate: string;
  priorSnapshotDate: string | null;
  scored: number;
  newArrivals: number;
  sectorGroups: number;
  subsectorGroups: number;
}

type SnapshotRow = Prisma.RevisionSnapshotGetPayload<{}>;

function dec(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function extractForwardMetricAvgs(estimatesJson: unknown): Partial<Record<BreadthMetric, number | null>> {
  const out: Partial<Record<BreadthMetric, number | null>> = {};
  if (!estimatesJson || typeof estimatesJson !== "object") return out;
  const j = estimatesJson as { nextFiscalDate?: string; annual?: unknown };
  const annual = Array.isArray(j.annual) ? (j.annual as Array<Record<string, unknown>>) : [];
  const fwd =
    annual.find((p) => p.fiscalDate === j.nextFiscalDate) ?? annual[annual.length - 1];
  if (!fwd) return out;
  const triple = (k: string): number | null => {
    const t = fwd[k] as { avg?: unknown } | undefined;
    const v = t?.avg;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  out.revenue = triple("revenue");
  out.eps = triple("eps");
  out.ebitda = triple("ebitda");
  out.ebit = triple("ebit");
  out.netIncome = triple("netIncome");
  return out;
}

function extractRatingDist(ratingsJson: unknown): RatingDist | null {
  if (!ratingsJson || typeof ratingsJson !== "object") return null;
  const d = (ratingsJson as { distribution?: unknown }).distribution as
    | Record<string, unknown>
    | undefined;
  if (!d) return null;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
  return {
    strongBuy: n("strongBuy"),
    buy: n("buy"),
    hold: n("hold"),
    sell: n("sell"),
    strongSell: n("strongSell"),
  };
}

function toStockWeek(row: SnapshotRow, snapshotIso: string): StockWeek {
  let daysToEarnings: number | null = null;
  if (row.nextEarningsDate) {
    const days = Math.round(
      (row.nextEarningsDate.getTime() - new Date(`${snapshotIso}T00:00:00Z`).getTime()) / 86_400_000,
    );
    daysToEarnings = days >= 0 ? days : null;
  }
  const metricAvgs = extractForwardMetricAvgs(row.estimatesJson);
  return {
    ticker: row.ticker,
    epsAvg: dec(row.epsAvg),
    revenueAvg: dec(row.revenueAvg),
    metricAvgs,
    epsLow: null,
    epsHigh: null,
    ratingDist: extractRatingDist(row.ratingsJson),
    ptConsensus: dec(row.ptConsensus),
    daysToEarnings,
  };
}

/** Decile (10 = strongest) of each composite within its group key. */
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

export async function scoreRevisionWeek(opts: ScoreOptions = {}): Promise<ScoreSummary> {
  const log = opts.log ?? (() => {});

  const latest = opts.snapshotDate
    ? new Date(`${opts.snapshotDate}T00:00:00Z`)
    : (await prisma.revisionSnapshot.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } }))?.snapshotDate ?? null;
  if (!latest) {
    log("[scoring] no snapshots present");
    return { snapshotDate: "", priorSnapshotDate: null, scored: 0, newArrivals: 0, sectorGroups: 0, subsectorGroups: 0 };
  }
  const snapshotIso = isoOf(latest);

  const current = await prisma.revisionSnapshot.findMany({ where: { snapshotDate: latest } });
  const priorDateRow = await prisma.revisionSnapshot.findFirst({
    where: { snapshotDate: { lt: latest } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const priorDate = priorDateRow?.snapshotDate ?? null;
  const priorRows = priorDate
    ? await prisma.revisionSnapshot.findMany({ where: { snapshotDate: priorDate } })
    : [];
  const priorByTicker = new Map(priorRows.map((r) => [r.ticker, toStockWeek(r, isoOf(priorDate!))]));

  const tickers = current.map((r) => r.ticker);
  const refs = await prisma.revisionReference.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, sector: true, subsector: true, companyName: true },
  });
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));

  // Per-stock raw signals.
  const stocks = current.map((row) => {
    const cur = toStockWeek(row, snapshotIso);
    const prior = priorByTicker.get(row.ticker) ?? null;
    return { row, cur, signals: computeRawSignals(cur, prior) };
  });

  // Peer groups (subsector-first, sector fallback).
  const classifications: RefClassification[] = stocks.map((s) => ({
    ticker: s.row.ticker,
    sector: refByTicker.get(s.row.ticker)?.sector ?? null,
    subsector: refByTicker.get(s.row.ticker)?.subsector ?? null,
  }));
  const peers = resolvePeerGroups(classifications);
  const peerKey = (i: number) => peers.get(stocks[i]!.row.ticker)!.peerGroupKey;

  // Z-score each composite signal WITHIN its peer group.
  const zBySignal: Array<{ key: string; z: Map<number, number> }> = [];
  for (const sig of COMPOSITE_SIGNALS) {
    const global = new Map<number, number>();
    const buckets = new Map<string, number[]>();
    stocks.forEach((_, i) => {
      const k = peerKey(i);
      const arr = buckets.get(k);
      if (arr) arr.push(i);
      else buckets.set(k, [i]);
    });
    for (const idxs of buckets.values()) {
      const sub = idxs.map((i) => (stocks[i]!.signals[sig] as number | null) ?? null);
      const { z } = zScores(sub);
      for (const [localIdx, zv] of z) global.set(idxs[localIdx]!, zv);
    }
    zBySignal.push({ key: sig as string, z: global });
  }

  const composites = compositeScores(zBySignal, stocks.length, opts.weights);

  // Global rank + within-sector / within-subsector deciles.
  const ranked = rankAndDecile(composites);
  const globalRank = new Map<number, number>();
  for (const e of ranked) globalRank.set(e.index, e.rank);

  const sectorKeys = classifications.map((c) => c.sector ?? "Unclassified");
  const subsectorKeys = classifications.map((c) => c.subsector ?? c.sector ?? "Unclassified");
  const sectorDeciles = decilesWithinGroups(composites, sectorKeys);
  const subsectorDeciles = decilesWithinGroups(composites, subsectorKeys);

  // Prior-week deciles for new-arrival detection.
  const priorScores = priorDate
    ? await prisma.revisionScore.findMany({
        where: { snapshotDate: priorDate },
        select: { ticker: true, subsectorDecile: true, sectorDecile: true },
      })
    : [];
  const priorDecileByTicker = new Map(
    priorScores.map((p) => [p.ticker, p.subsectorDecile ?? p.sectorDecile ?? null]),
  );

  // Persist RevisionScore + build queue rows.
  let scored = 0;
  let newArrivals = 0;
  const queueRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i]!;
    const peer = peers.get(s.row.ticker)!;
    const composite = composites[i];
    const subDecile = subsectorDeciles[i];
    const secDecile = sectorDeciles[i];
    const primaryDecile = peer.peerGroupType === "SUBSECTOR" ? subDecile : secDecile;
    const newArrival = isNewArrival(primaryDecile, priorDecileByTicker.get(s.row.ticker) ?? null);
    if (newArrival) newArrivals++;

    const z = Object.fromEntries(zBySignal.map((zs) => [zs.key, zs.z.get(i) ?? null]));
    const ref = refByTicker.get(s.row.ticker);
    const scoreJson = {
      signals: s.signals as RawSignals,
      z,
      ratingNet: s.signals.ratingNet,
      epsDispersion: s.signals.epsDispersion,
      peerGroup: peer,
    } as unknown as Prisma.InputJsonValue;

    try {
      await prisma.revisionScore.upsert({
        where: { ticker_snapshotDate: { ticker: s.row.ticker, snapshotDate: latest } },
        create: {
          ticker: s.row.ticker,
          snapshotDate: latest,
          peerGroupType: peer.peerGroupType,
          peerGroupKey: peer.peerGroupKey,
          composite: composite ?? null,
          subsectorDecile: subDecile,
          sectorDecile: secDecile,
          rank: globalRank.get(i) ?? null,
          newArrival,
          scoreJson: scoreJson as Prisma.InputJsonValue,
        },
        update: {
          peerGroupType: peer.peerGroupType,
          peerGroupKey: peer.peerGroupKey,
          composite: composite ?? null,
          subsectorDecile: subDecile,
          sectorDecile: secDecile,
          rank: globalRank.get(i) ?? null,
          newArrival,
          scoreJson: scoreJson as Prisma.InputJsonValue,
        },
      });
      scored++;
    } catch (e) {
      log(`[scoring] ${s.row.ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }

    queueRows.push({
      ticker: s.row.ticker,
      companyName: ref?.companyName ?? s.row.ticker,
      sector: ref?.sector ?? null,
      subsector: ref?.subsector ?? null,
      composite,
      rank: globalRank.get(i) ?? null,
      subsectorDecile: subDecile,
      sectorDecile: secDecile,
      newArrival,
      signals: s.signals,
      z,
      nextEarningsDate: s.row.nextEarningsDate ? isoOf(s.row.nextEarningsDate) : null,
    });
  }
  queueRows.sort((a, b) => ((b.composite as number) ?? -Infinity) - ((a.composite as number) ?? -Infinity));

  // Sector + subsector aggregates.
  const withScores = stocks.map((s, i) => ({ ...s, composite: composites[i] ?? null }));
  const sectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.row.ticker)?.sector ?? "Unclassified",
    (s) => s.signals.estimateBreadth,
    (s) => s.composite,
  );
  const subsectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.row.ticker)?.subsector ?? refByTicker.get(s.row.ticker)?.sector ?? "Unclassified",
    (s) => s.signals.estimateBreadth,
    (s) => s.composite,
  );

  for (const [type, rollups] of [
    ["SECTOR", sectorRollups],
    ["SUBSECTOR", subsectorRollups],
  ] as const) {
    for (const g of rollups) {
      await prisma.revisionSectorAggregate.upsert({
        where: { groupType_groupKey_snapshotDate: { groupType: type, groupKey: g.groupKey, snapshotDate: latest } },
        create: {
          groupType: type,
          groupKey: g.groupKey,
          snapshotDate: latest,
          breadth: g.breadth,
          compositeMean: g.compositeMean,
          nameCount: g.nameCount,
        },
        update: { breadth: g.breadth, compositeMean: g.compositeMean, nameCount: g.nameCount },
      });
    }
  }

  // Ranked queue output cache.
  await prisma.researchQueueSnapshot.upsert({
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

  log(`[scoring] scored ${scored}, new arrivals ${newArrivals}, sectors ${sectorRollups.length}, subsectors ${subsectorRollups.length}`);
  return {
    snapshotDate: snapshotIso,
    priorSnapshotDate: priorDate ? isoOf(priorDate) : null,
    scored,
    newArrivals,
    sectorGroups: sectorRollups.length,
    subsectorGroups: subsectorRollups.length,
  };
}
