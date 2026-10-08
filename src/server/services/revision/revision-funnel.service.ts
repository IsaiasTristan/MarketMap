/**
 * Engine 1 — the Validation canvas payload.
 *
 * Measures the SAME rank the screens serve (`RevisionScreenRow.ptRevOrthZ`)
 * over the full 143-week Leg-B grid, on t+1 (`closeNext`) entries at both
 * ends. The headline is funnel precision — what the top 25 a user actually
 * reads returned against a random 25 from the same eligible set — because a
 * universe-wide IC of 0.01 says nothing about the top of a list. The IC line
 * stays, as one row, with naive AND Newey-West t-stats plus effective weeks;
 * nothing renders as a headline below `validationHeadlineMinWeeks` effective
 * weeks.
 *
 * Heavy (a few hundred thousand rows, 1,000 random draws per horizon), so the
 * payload is cached in RevisionAnalyticsSnapshot under kind "funnel-validation"
 * and recomputed by the weekly pipeline.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { resolvePeerGroups, type RefClassification } from "@/lib/revision/aggregate";
import { icSummary, neweyWestTStat, spearman } from "@/lib/revision/backtest";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  cutStats,
  nextPrintOutcome,
  queueOverlap,
  survivorshipNote,
  topKPrecision,
  type CutStats,
  type FunnelWeek,
  type NextPrintOutcome,
  type QueueOverlap,
  type SurvivorshipNote,
  type TopKPrecision,
} from "@/lib/revision/funnel-metrics";
import { forwardReturns } from "@/lib/revision/prices";
import { loadMarketCaps } from "./revision-rank.service";

const DAY_MS = 86_400_000;
const FUNNEL_KIND = "funnel-validation";
const HORIZONS = [1, 2, 4, 8, 13, 26];
/** Horizons the funnel block is reported at. */
const FUNNEL_HORIZONS = [4, 13];
const TOP_K = 25;
const RANDOM_DRAWS = 1000;
/** Fixed so a reported baseline is reproducible between runs. */
const RANDOM_SEED = 20260916;
/** Deciles the bar chart splits the universe into. */
const DECILES = 10;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface IcByHorizon {
  horizonWeeks: number;
  meanIC: number | null;
  naiveT: number | null;
  hacT: number | null;
  /** Independent observations after the overlapping-window correction. */
  effectiveWeeks: number | null;
  weeks: number;
}

export interface FunnelBlock {
  horizonWeeks: number;
  topK: TopKPrecision;
  overlap: QueueOverlap;
  capTerciles: CutStats[];
  coverageTerciles: CutStats[];
  earningsWindow: CutStats[];
  nextPrint: NextPrintOutcome;
  /** Mean peer-relative forward return per rank decile (1 = weakest). */
  decileReturns: Array<{ decile: number; meanReturn: number | null; tickerWeeks: number }>;
  /** Trailing weekly IC, for the rolling line. */
  rollingIc: Array<{ date: string; ic: number | null }>;
}

export interface FunnelValidationPayload {
  generatedAt: string;
  snapshotDate: string;
  grid: { weeks: number; from: string; to: string };
  rankSignal: string;
  entry: string;
  headlineMinWeeks: number;
  /** The headline horizon's effective weeks; below the minimum the UI reads ACCRUING. */
  headlineEffectiveWeeks: number | null;
  headlineReady: boolean;
  icByHorizon: IcByHorizon[];
  funnel: FunnelBlock[];
  survivorship: SurvivorshipNote;
}

export async function computeFunnelValidation(
  log: (msg: string) => void = () => {},
): Promise<FunnelValidationPayload | null> {
  const gridRows = await prisma.revisionUniverseWeek.findMany({
    orderBy: { snapshotDate: "asc" },
    select: { snapshotDate: true },
  });
  if (gridRows.length === 0) return null;
  const grid = gridRows.map((g) => isoOf(g.snapshotDate));
  const gridIdx = new Map(grid.map((d, i) => [d, i]));

  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true, sector: true, subsector: true },
  });
  const peerGroups = resolvePeerGroups(refs as RefClassification[]);
  const peerOf = new Map([...peerGroups.entries()].map(([t, g]) => [t, g.peerGroupKey]));

  // ---- the rank, straight off the materialized screen rows ----
  const rankZ = new Map<string, Array<number | null>>();
  const panelSize = new Map<string, Array<number | null>>();
  const tickers = new Set<string>();
  const screenRows = await prisma.revisionScreenRow.findMany({
    select: { ticker: true, snapshotDate: true, ptRevOrthZ: true, analystCount: true },
  });
  for (const r of screenRows) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w === undefined) continue;
    tickers.add(r.ticker);
    let z = rankZ.get(r.ticker);
    if (!z) {
      z = new Array<number | null>(grid.length).fill(null);
      rankZ.set(r.ticker, z);
      panelSize.set(r.ticker, new Array<number | null>(grid.length).fill(null));
    }
    z[w] = r.ptRevOrthZ;
    panelSize.get(r.ticker)![w] = r.analystCount;
  }
  log(`[funnel] ${tickers.size} tickers over ${grid.length} grid weeks`);

  // ---- t+1 entries -> peer-relative forward returns ----
  const entryByTicker = new Map<string, Array<number | null>>();
  const presentByWeek: Array<Set<string>> = grid.map(() => new Set<string>());
  for (const t of tickers) entryByTicker.set(t, new Array<number | null>(grid.length).fill(null));
  const priceRows = await prisma.revisionPriceSnapshot.findMany({
    select: { ticker: true, snapshotDate: true, close: true, closeNext: true },
  });
  for (const p of priceRows) {
    const w = gridIdx.get(isoOf(p.snapshotDate));
    if (w === undefined || !entryByTicker.has(p.ticker)) continue;
    if (p.closeNext !== null) entryByTicker.get(p.ticker)![w] = p.closeNext;
    if (p.close !== null) presentByWeek[w]!.add(p.ticker);
  }

  const forwardByHorizon = new Map<number, Array<Map<string, number>>>();
  let droppedNoEntry = 0;
  for (const h of HORIZONS) {
    const perTicker = new Map<string, Array<number | null>>();
    for (const t of tickers) {
      const f = forwardReturns(entryByTicker.get(t)!, h);
      perTicker.set(t, f.values);
      if (h === FUNNEL_HORIZONS[0]) droppedNoEntry += f.dropped;
    }
    const perWeek: Array<Map<string, number>> = [];
    for (let w = 0; w < grid.length; w++) {
      const raw = new Map<string, number>();
      const groups = new Map<string, { sum: number; n: number }>();
      for (const t of tickers) {
        const r = perTicker.get(t)![w];
        if (r == null) continue;
        raw.set(t, r);
        const key = peerOf.get(t) ?? "Unclassified";
        const acc = groups.get(key);
        if (acc) {
          acc.sum += r;
          acc.n++;
        } else groups.set(key, { sum: r, n: 1 });
      }
      const rel = new Map<string, number>();
      for (const [t, r] of raw) {
        const acc = groups.get(peerOf.get(t) ?? "Unclassified")!;
        rel.set(t, r - acc.sum / acc.n);
      }
      perWeek.push(rel);
    }
    forwardByHorizon.set(h, perWeek);
  }

  const weeksAt = (h: number): FunnelWeek[] => {
    const fwd = forwardByHorizon.get(h)!;
    return grid.map((date, w) => {
      const score = new Map<string, number>();
      for (const t of tickers) {
        const z = rankZ.get(t)![w];
        if (z !== null && Number.isFinite(z)) score.set(t, z);
      }
      return { date, score, forward: fwd[w]! };
    });
  };

  // ---- IC by horizon (naive + HAC) ----
  const icByHorizon: IcByHorizon[] = HORIZONS.map((h) => {
    const ics = weeksAt(h).map((w) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [t, z] of w.score) {
        const r = w.forward.get(t);
        if (r === undefined) continue;
        xs.push(z);
        ys.push(r);
      }
      return xs.length >= 10 ? spearman(xs, ys) : null;
    });
    const naive = icSummary(ics);
    const hac = neweyWestTStat(ics, h - 1);
    return {
      horizonWeeks: h,
      meanIC: naive.mean,
      naiveT: naive.tStat,
      hacT: hac.tStat,
      effectiveWeeks: hac.effectiveN === null ? null : Math.round(hac.effectiveN),
      weeks: naive.n,
    };
  });

  // ---- cuts ----
  const capByTicker = await loadMarketCaps();
  const capValues = [...capByTicker.values()].sort((a, b) => a - b);
  const capCuts: [number, number] = [
    capValues[Math.floor(capValues.length / 3)] ?? 0,
    capValues[Math.floor((2 * capValues.length) / 3)] ?? 0,
  ];
  const tercile = (v: number) => (v <= capCuts[0] ? "LOW" : v <= capCuts[1] ? "MID" : "HIGH");

  const reportsByTicker = new Map<string, Array<{ iso: string; beat: boolean | null }>>();
  for (const r of await prisma.earningsSurprise.findMany({
    select: { ticker: true, reportDate: true, epsActual: true, epsEstimated: true },
    orderBy: { reportDate: "asc" },
  })) {
    const a = r.epsActual === null ? null : Number(r.epsActual);
    const e = r.epsEstimated === null ? null : Number(r.epsEstimated);
    const arr = reportsByTicker.get(r.ticker) ?? [];
    arr.push({ iso: isoOf(r.reportDate), beat: a !== null && e !== null ? a > e : null });
    reportsByTicker.set(r.ticker, arr);
  }
  const daysSincePrint = (date: string, ticker: string): number | null => {
    const arr = reportsByTicker.get(ticker);
    if (!arr) return null;
    let last: string | null = null;
    for (const r of arr) {
      if (r.iso <= date) last = r.iso;
      else break;
    }
    return last === null
      ? null
      : Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${last}T00:00:00Z`).getTime()) / DAY_MS);
  };
  const nextBeat = (date: string, ticker: string): boolean | null =>
    reportsByTicker.get(ticker)?.find((r) => r.iso > date)?.beat ?? null;
  const nextNetUp = (date: string, ticker: string): boolean | null => {
    const w = gridIdx.get(date);
    if (w === undefined || w + 1 >= grid.length) return null;
    const v = rankZ.get(ticker)?.[w + 1];
    return v === null || v === undefined ? null : v > 0;
  };

  const funnel: FunnelBlock[] = FUNNEL_HORIZONS.map((h) => {
    const weeks = weeksAt(h);
    // Decile bars + the rolling IC line come off the same weekly slices.
    const decileSums = Array.from({ length: DECILES }, () => ({ sum: 0, n: 0 }));
    const rollingIc: Array<{ date: string; ic: number | null }> = [];
    for (const w of weeks) {
      const eligible = [...w.score.entries()]
        .filter(([t]) => w.forward.has(t))
        .sort((a, b) => a[1] - b[1]);
      if (eligible.length >= DECILES) {
        eligible.forEach(([t], i) => {
          const d = Math.min(DECILES - 1, Math.floor((i / eligible.length) * DECILES));
          decileSums[d]!.sum += w.forward.get(t)!;
          decileSums[d]!.n++;
        });
      }
      rollingIc.push({
        date: w.date,
        ic:
          eligible.length >= 10
            ? spearman(eligible.map(([, z]) => z), eligible.map(([t]) => w.forward.get(t)!))
            : null,
      });
    }
    return {
      horizonWeeks: h,
      topK: topKPrecision(weeks, TOP_K, { draws: RANDOM_DRAWS, seed: RANDOM_SEED }),
      overlap: queueOverlap(weeks, TOP_K),
      capTerciles: cutStats(
        weeks,
        (_d, t) => {
          const c = capByTicker.get(t);
          return c === undefined ? null : `cap:${tercile(c)}`;
        },
        spearman,
      ),
      coverageTerciles: cutStats(
        weeks,
        (d, t) => {
          const n = panelSize.get(t)?.[gridIdx.get(d)!];
          return n === null || n === undefined ? null : `cov:${n <= 4 ? "THIN" : n <= 10 ? "MID" : "DEEP"}`;
        },
        spearman,
      ),
      earningsWindow: cutStats(
        weeks,
        (d, t) => {
          const days = daysSincePrint(d, t);
          return days === null ? null : days <= 14 ? "er:0-14d" : "er:rest";
        },
        spearman,
      ),
      nextPrint: nextPrintOutcome(weeks, TOP_K, nextBeat, nextNetUp),
      decileReturns: decileSums.map((d, i) => ({
        decile: i + 1,
        meanReturn: d.n > 0 ? d.sum / d.n : null,
        tickerWeeks: d.n,
      })),
      rollingIc,
    };
  });

  const headline = icByHorizon.find((r) => r.horizonWeeks === FUNNEL_HORIZONS[0])!;
  const snapshotDate = grid[grid.length - 1]!;

  return {
    generatedAt: new Date().toISOString(),
    snapshotDate,
    grid: { weeks: grid.length, from: grid[0]!, to: snapshotDate },
    rankSignal: "ptRevOrthZ",
    entry: "closeNext (t+1 close, both ends)",
    headlineMinWeeks: REVISION_THRESHOLDS.validationHeadlineMinWeeks,
    headlineEffectiveWeeks: headline.effectiveWeeks,
    headlineReady:
      headline.effectiveWeeks !== null &&
      headline.effectiveWeeks >= REVISION_THRESHOLDS.validationHeadlineMinWeeks,
    icByHorizon,
    funnel,
    survivorship: survivorshipNote(
      grid.map((date, w) => ({ date, present: presentByWeek[w]! })),
      tickers,
      droppedNoEntry,
    ),
  };
}

/** Recompute + cache (weekly pipeline). */
export async function computeAndCacheFunnelValidation(
  log: (msg: string) => void = () => {},
): Promise<FunnelValidationPayload | null> {
  const payload = await computeFunnelValidation(log);
  if (!payload) return null;
  const snapshotDate = new Date(`${payload.snapshotDate}T00:00:00Z`);
  await prisma.revisionAnalyticsSnapshot.upsert({
    where: { kind_snapshotDate: { kind: FUNNEL_KIND, snapshotDate } },
    create: {
      kind: FUNNEL_KIND,
      snapshotDate,
      payloadJson: payload as unknown as Prisma.InputJsonValue,
    },
    update: { payloadJson: payload as unknown as Prisma.InputJsonValue, computedAt: new Date() },
  });
  log(`[funnel] cached ${FUNNEL_KIND} @ ${payload.snapshotDate}`);
  return payload;
}

/** Cached payload; computes + caches on a cold miss. */
export async function getFunnelValidation(): Promise<FunnelValidationPayload | null> {
  const cached = await prisma.revisionAnalyticsSnapshot.findFirst({
    where: { kind: FUNNEL_KIND },
    orderBy: { snapshotDate: "desc" },
  });
  const latestGrid = await prisma.revisionUniverseWeek.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latestGrid) return null;
  if (cached && cached.snapshotDate.getTime() === latestGrid.snapshotDate.getTime()) {
    return cached.payloadJson as unknown as FunnelValidationPayload;
  }
  return computeAndCacheFunnelValidation();
}
