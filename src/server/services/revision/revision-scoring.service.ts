/**
 * Engine 1 — signal + scoring layer. Reads the append-only snapshots, computes
 * per-stock revision signals, and writes RevisionScore +
 * RevisionSectorAggregate + the ResearchQueueSnapshot output cache.
 *
 * THE RANK IS ONE SIGNAL: `ptRevOrthZ` (see revision-rank.service). Rank,
 * deciles, new-arrival, gap, the smoothed mean, streaks, the group/idio
 * decomposition, the group aggregates and every transition detector all key
 * off it. The legacy 5-signal equal-weight composite is still computed and
 * stored, but purely as reference — it was never validated at depth, and
 * blending un-validated signals is what made the old queue rank on price
 * moves rather than on revisions.
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
  meanOrNull,
  type RefClassification,
} from "@/lib/revision/aggregate";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  computeStreak,
  decomposeComposites,
  dispersionTrend,
  trailingMean,
  type Streak,
} from "@/lib/revision/derived";
import { computeWeekRanks, loadRankRefs } from "./revision-rank.service";
import {
  detectGroupTransitions,
  detectStockTransitions,
  nextSide,
  type GroupWeekMetrics,
  type Side,
  type StockWeekMetrics,
  type TransitionDraft,
} from "@/lib/revision/transitions";
import { writeWeeklyTransitions } from "./revision-transitions.service";

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
  transitionsWritten: number;
  legADepthWeeks: number;
  priceCoverage: number; // share of scored names with a 4w return this week
}

type SnapshotRow = Prisma.RevisionSnapshotGetPayload<Record<string, never>>;

function dec(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The forward fiscal period from estimatesJson (nextFiscalDate match, else the last). Pure, exported for tests. */
export function pickForwardPeriod(estimatesJson: unknown): Record<string, unknown> | null {
  if (!estimatesJson || typeof estimatesJson !== "object") return null;
  const j = estimatesJson as { nextFiscalDate?: string; annual?: unknown };
  const annual = Array.isArray(j.annual) ? (j.annual as Array<Record<string, unknown>>) : [];
  return annual.find((p) => p.fiscalDate === j.nextFiscalDate) ?? annual[annual.length - 1] ?? null;
}

function tripleField(fwd: Record<string, unknown>, k: string, field: "low" | "avg" | "high"): number | null {
  const t = fwd[k] as Partial<Record<"low" | "avg" | "high", unknown>> | undefined;
  const v = t?.[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function periodMetricAvgs(fwd: Record<string, unknown>): Partial<Record<BreadthMetric, number | null>> {
  return {
    revenue: tripleField(fwd, "revenue", "avg"),
    eps: tripleField(fwd, "eps", "avg"),
    ebitda: tripleField(fwd, "ebitda", "avg"),
    ebit: tripleField(fwd, "ebit", "avg"),
    netIncome: tripleField(fwd, "netIncome", "avg"),
  };
}

function extractForwardMetricAvgs(estimatesJson: unknown): Partial<Record<BreadthMetric, number | null>> {
  const fwd = pickForwardPeriod(estimatesJson);
  return fwd ? periodMetricAvgs(fwd) : {};
}

/** Fiscal date of the forward period the leaders describe (for like-for-like revisions). */
export function extractForwardFiscalDate(estimatesJson: unknown): string | null {
  const fwd = pickForwardPeriod(estimatesJson);
  const d = fwd?.fiscalDate;
  return typeof d === "string" ? d : null;
}

/** Consensus avgs for EVERY annual period, keyed by fiscalDate — the like-for-like lookup table. */
export function extractPeriodAvgs(
  estimatesJson: unknown,
): Map<string, Partial<Record<BreadthMetric, number | null>>> {
  const map = new Map<string, Partial<Record<BreadthMetric, number | null>>>();
  if (!estimatesJson || typeof estimatesJson !== "object") return map;
  const annual = (estimatesJson as { annual?: unknown }).annual;
  if (!Array.isArray(annual)) return map;
  for (const p of annual as Array<Record<string, unknown>>) {
    const d = p.fiscalDate;
    if (typeof d === "string") map.set(d, periodMetricAvgs(p));
  }
  return map;
}

/** Forward-period EPS low/high — feeds epsDispersion. Pure, exported for tests. */
export function extractForwardEps(estimatesJson: unknown): { low: number | null; high: number | null } {
  const fwd = pickForwardPeriod(estimatesJson);
  if (!fwd) return { low: null, high: null };
  return { low: tripleField(fwd, "eps", "low"), high: tripleField(fwd, "eps", "high") };
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
  const epsRange = extractForwardEps(row.estimatesJson);
  return {
    ticker: row.ticker,
    epsAvg: dec(row.epsAvg),
    revenueAvg: dec(row.revenueAvg),
    metricAvgs,
    epsLow: epsRange.low,
    epsHigh: epsRange.high,
    ratingDist: extractRatingDist(row.ratingsJson),
    ptConsensus: dec(row.ptConsensus),
    daysToEarnings,
    forwardFiscalDate: extractForwardFiscalDate(row.estimatesJson),
    periodAvgs: extractPeriodAvgs(row.estimatesJson),
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
    return {
      snapshotDate: "",
      priorSnapshotDate: null,
      scored: 0,
      newArrivals: 0,
      sectorGroups: 0,
      subsectorGroups: 0,
      transitionsWritten: 0,
      legADepthWeeks: 0,
      priceCoverage: 0,
    };
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

  // Reference only — retired from ranking, retained in scoreJson / the
  // composite column so historical weeks stay readable.
  const composites = compositeScores(zBySignal, stocks.length, opts.weights);

  // ---- THE RANK ----
  // One signal, computed over the FULL Leg-B universe for this date (not just
  // the tickers with an estimates snapshot) so the cross-sectional
  // orthogonalization and the peer z see the whole market.
  const HIST_WEEKS = 40;
  const rankRefs = await loadRankRefs();
  const legbDateRows = await prisma.revisionLegBWeekly.findMany({
    where: { snapshotDate: { lte: latest } },
    distinct: ["snapshotDate"],
    orderBy: { snapshotDate: "desc" },
    take: HIST_WEEKS,
    select: { snapshotDate: true },
  });
  const rankDates = legbDateRows.map((r) => r.snapshotDate);
  if (!rankDates.some((d) => d.getTime() === latest.getTime())) rankDates.push(latest);
  rankDates.sort((a, b) => a.getTime() - b.getTime());
  const rankWeeks = await computeWeekRanks(rankDates, rankRefs);
  const currentRank = rankWeeks[rankWeeks.length - 1]!;
  /** Per-ticker rank history, oldest first — drives the smoothed mean + streaks. */
  const rankHistByTicker = new Map<string, Array<number | null>>();
  rankWeeks.forEach((w, wi) => {
    for (const e of w.entries) {
      let arr = rankHistByTicker.get(e.ticker);
      if (!arr) {
        arr = new Array<number | null>(rankWeeks.length).fill(null);
        rankHistByTicker.set(e.ticker, arr);
      }
      arr[wi] = e.ptRevOrthZ;
    }
  });

  const rankZ = stocks.map((s) => currentRank.byTicker.get(s.row.ticker)?.ptRevOrthZ ?? null);
  const rankRaw = stocks.map((s) => currentRank.byTicker.get(s.row.ticker)?.ptRevOrthRaw ?? null);
  // Universe-scale twin of the rank. The peer z has ~zero mean inside every
  // peer bucket by construction, so group-level analytics need this instead.
  const rankGlobalZ = stocks.map(
    (s) => currentRank.byTicker.get(s.row.ticker)?.ptRevOrthGlobalZ ?? null,
  );

  // Global rank + within-sector / within-subsector deciles, all on the rank.
  const ranked = rankAndDecile(rankZ);
  const globalRank = new Map<number, number>();
  for (const e of ranked) globalRank.set(e.index, e.rank);

  const sectorKeys = classifications.map((c) => c.sector ?? "Unclassified");
  const subsectorKeys = classifications.map((c) => c.subsector ?? c.sector ?? "Unclassified");
  const sectorDeciles = decilesWithinGroups(rankZ, sectorKeys);
  const subsectorDeciles = decilesWithinGroups(rankZ, subsectorKeys);

  // Prior-week deciles + decision-state (side / streak) for change detection.
  const priorScores = priorDate
    ? await prisma.revisionScore.findMany({
        where: { snapshotDate: priorDate },
        select: {
          ticker: true,
          subsectorDecile: true,
          sectorDecile: true,
          side: true,
          streakLen: true,
          streakSign: true,
        },
      })
    : [];
  const priorDecileByTicker = new Map(
    priorScores.map((p) => [p.ticker, p.subsectorDecile ?? p.sectorDecile ?? null]),
  );
  const priorStateByTicker = new Map(
    priorScores.map((p) => [
      p.ticker,
      {
        side: (p.side === "LONG" || p.side === "SHORT" ? p.side : null) as Side,
        streak:
          p.streakLen !== null && p.streakSign !== null
            ? ({ len: p.streakLen, sign: p.streakSign as -1 | 0 | 1 } satisfies Streak)
            : null,
      },
    ]),
  );

  // ---- Derived decision metrics (gap score + friends) ----
  const t = REVISION_THRESHOLDS;

  // Weekly price returns at the snapshot date (px z comes from the rank
  // service, which computes it over the same full universe).
  const priceRows = await prisma.revisionPriceSnapshot.findMany({
    where: { snapshotDate: latest, ticker: { in: tickers } },
    select: { ticker: true, ret1w: true, ret4w: true, ret13w: true },
  });
  const priceByTicker = new Map(priceRows.map((p) => [p.ticker, p]));

  // Scored-week history — only feeds the epsDispersion trend now that the
  // rank carries its own (deeper) history.
  const histDateRows = await prisma.revisionScore.findMany({
    where: { snapshotDate: { lt: latest } },
    distinct: ["snapshotDate"],
    orderBy: { snapshotDate: "desc" },
    take: HIST_WEEKS,
    select: { snapshotDate: true },
  });
  const histDates = histDateRows.map((r) => r.snapshotDate).sort((a, b) => a.getTime() - b.getTime());
  const legADepthWeeks = histDates.length + 1; // prior scored weeks + this one

  // epsDispersion history (from scoreJson) for the dispersion trend.
  const dispDates = histDates.slice(Math.max(0, histDates.length - (t.dispersionTrendWindow - 1)));
  const dispRows = dispDates.length
    ? await prisma.revisionScore.findMany({
        where: { snapshotDate: { in: dispDates }, ticker: { in: tickers } },
        select: { ticker: true, snapshotDate: true, scoreJson: true },
      })
    : [];
  const dispIdx = new Map(dispDates.map((d, i) => [d.getTime(), i]));
  const dispHistByTicker = new Map<string, Array<number | null>>();
  for (const r of dispRows) {
    let arr = dispHistByTicker.get(r.ticker);
    if (!arr) {
      arr = new Array<number | null>(dispDates.length).fill(null);
      dispHistByTicker.set(r.ticker, arr);
    }
    const j = r.scoreJson as { epsDispersion?: unknown } | null;
    const v = j && typeof j.epsDispersion === "number" && Number.isFinite(j.epsDispersion) ? j.epsDispersion : null;
    arr[dispIdx.get(r.snapshotDate.getTime())!] = v;
  }

  // Group / idio decomposition on the universe-scale rank (grp + idio sum to it).
  const primaryKeys = stocks.map((s) => peers.get(s.row.ticker)!.peerGroupKey);
  const decomposition = decomposeComposites(rankGlobalZ, primaryKeys);

  /** The rank is the only series streaks read, over the full Leg-B grid. */
  const streakSource = "RANK";
  interface DerivedRow {
    px4wZ: number | null;
    gapScore: number | null;
    composite4wZ: number | null;
    composite4wWeeksUsed: number;
    globalComposite: number | null;
    groupZ: number | null;
    idioZ: number | null;
    streak: Streak;
    streakHistory: Array<-1 | 0 | 1>;
    streakSource: string;
    side: Side;
    dispersionTrend: ReturnType<typeof dispersionTrend>;
    ret1w: number | null;
    ret4w: number | null;
    ret13w: number | null;
  }
  const derived: DerivedRow[] = stocks.map((s, i) => {
    const ticker = s.row.ticker;
    const entry = currentRank.byTicker.get(ticker);
    const series = rankHistByTicker.get(ticker) ?? [];
    // Smoothed rank — display only; the gap and the flags read the raw week.
    const c4 = trailingMean(series, t.composite4wWindow);
    const px = entry?.pxZ ?? null;
    const gap = entry?.gap ?? null;
    const streak = computeStreak(series);
    const streakHistory = series
      .slice(Math.max(0, series.length - t.streakDisplayWeeks))
      .map((v): -1 | 0 | 1 => (v === null || !Number.isFinite(v) || v === 0 ? 0 : v > 0 ? 1 : -1));
    const dispSeries = [...(dispHistByTicker.get(ticker) ?? []), s.signals.epsDispersion ?? null];
    const prior = priorStateByTicker.get(ticker);
    const peer = peers.get(ticker)!;
    const primaryDecile =
      peer.peerGroupType === "SUBSECTOR" ? subsectorDeciles[i] ?? null : sectorDeciles[i] ?? null;
    const price = priceByTicker.get(ticker);
    return {
      px4wZ: px,
      gapScore: gap,
      composite4wZ: c4.value,
      composite4wWeeksUsed: c4.weeksUsed,
      globalComposite: rankGlobalZ[i] ?? null,
      groupZ: decomposition.groupZ[i] ?? null,
      idioZ: decomposition.idioZ[i] ?? null,
      streak,
      streakHistory,
      streakSource,
      side: nextSide(prior?.side ?? null, primaryDecile, gap),
      dispersionTrend: dispersionTrend(dispSeries),
      ret1w: price?.ret1w ?? null,
      ret4w: price?.ret4w ?? null,
      ret13w: price?.ret13w ?? null,
    };
  });

  // Persist RevisionScore + build queue rows.
  let scored = 0;
  let newArrivals = 0;
  const queueRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i]!;
    const peer = peers.get(s.row.ticker)!;
    const rankScore = rankZ[i] ?? null;
    const legacyComposite = composites[i] ?? null;
    const subDecile = subsectorDeciles[i];
    const secDecile = sectorDeciles[i];
    const primaryDecile = peer.peerGroupType === "SUBSECTOR" ? subDecile : secDecile;
    const newArrival = isNewArrival(primaryDecile, priorDecileByTicker.get(s.row.ticker) ?? null);
    if (newArrival) newArrivals++;

    const z = Object.fromEntries(zBySignal.map((zs) => [zs.key, zs.z.get(i) ?? null]));
    const ref = refByTicker.get(s.row.ticker);
    const d = derived[i]!;
    const daysToEarnings = s.cur.daysToEarnings;
    const setupTags: string[] = [];
    if (d.gapScore !== null && Math.abs(d.gapScore) >= t.newFlagMinAbsGap) setupTags.push("UNPR");
    if (d.streak.len >= t.streakBrokenMinLen) setupTags.push("STRK");
    if (daysToEarnings !== null && daysToEarnings <= t.erWindowDays) setupTags.push("ER");
    // DOMINO tags are appended after group detection below.
    const derivedJson = {
      px4wZ: d.px4wZ,
      gapScore: d.gapScore,
      composite4wZ: d.composite4wZ,
      composite4wWeeksUsed: d.composite4wWeeksUsed,
      globalComposite: d.globalComposite,
      groupZ: d.groupZ,
      idioZ: d.idioZ,
      streak: { len: d.streak.len, sign: d.streak.sign, source: d.streakSource },
      streakHistory: d.streakHistory,
      side: d.side,
      dispersionTrend: d.dispersionTrend,
      ret1w: d.ret1w,
      ret4w: d.ret4w,
      ret13w: d.ret13w,
    };
    const scoreJson = {
      signals: s.signals as RawSignals,
      z,
      ratingNet: s.signals.ratingNet,
      epsDispersion: s.signals.epsDispersion,
      peerGroup: peer,
      derived: derivedJson,
      rank: {
        ptRevOrthZ: rankScore,
        ptRevOrthRaw: rankRaw[i] ?? null,
        ptRevOrthGlobalZ: rankGlobalZ[i] ?? null,
        ptRevisionRecon: currentRank.byTicker.get(s.row.ticker)?.ptRevisionRecon ?? null,
        orthBeta: currentRank.beta,
      },
      // Retired from ranking; kept so old weeks stay reconstructible.
      legacyComposite,
    } as unknown as Prisma.InputJsonValue;

    const scoreFields = {
      peerGroupType: peer.peerGroupType,
      peerGroupKey: peer.peerGroupKey,
      ptRevOrthZ: rankScore,
      ptRevOrthRaw: rankRaw[i] ?? null,
      composite: legacyComposite,
      subsectorDecile: subDecile,
      sectorDecile: secDecile,
      rank: globalRank.get(i) ?? null,
      newArrival,
      px4wZ: d.px4wZ,
      gapScore: d.gapScore,
      composite4wZ: d.composite4wZ,
      groupZ: d.groupZ,
      idioZ: d.idioZ,
      streakLen: d.streak.len,
      streakSign: d.streak.sign,
      streakSource: d.streakSource,
      side: d.side,
      dispersionTrend: d.dispersionTrend,
      scoreJson: scoreJson as Prisma.InputJsonValue,
    };
    try {
      await prisma.revisionScore.upsert({
        where: { ticker_snapshotDate: { ticker: s.row.ticker, snapshotDate: latest } },
        create: { ticker: s.row.ticker, snapshotDate: latest, ...scoreFields },
        update: scoreFields,
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
      // `composite` is the queue's ranking value — now the single rank signal.
      composite: rankScore,
      legacyComposite,
      rank: globalRank.get(i) ?? null,
      subsectorDecile: subDecile,
      sectorDecile: secDecile,
      newArrival,
      signals: s.signals,
      z,
      nextEarningsDate: s.row.nextEarningsDate ? isoOf(s.row.nextEarningsDate) : null,
      gapScore: d.gapScore,
      px4wZ: d.px4wZ,
      composite4wZ: d.composite4wZ,
      composite4wWeeksUsed: d.composite4wWeeksUsed,
      streak: { len: d.streak.len, sign: d.streak.sign, source: d.streakSource },
      streakHistory: d.streakHistory,
      dispersionTrend: d.dispersionTrend,
      side: d.side,
      setupTags,
      groupZ: d.groupZ,
      idioZ: d.idioZ,
      globalComposite: d.globalComposite,
      daysToEarnings,
    });
  }
  queueRows.sort((a, b) => ((b.composite as number) ?? -Infinity) - ((a.composite as number) ?? -Infinity));

  // Sector + subsector aggregates on the rank. compositeMean keeps its
  // peer-relative semantics for the rotation/heatmap views; group-level SIGNAL
  // analytics use globalMeanZ (mean of the universe-scale rank), which is the
  // only one that actually varies across groups.
  const withScores = stocks.map((s, i) => ({
    ...s,
    composite: rankZ[i] ?? null,
    globalComposite: rankGlobalZ[i] ?? null,
  }));
  const sectorKeyOf = (s: (typeof withScores)[number]) => refByTicker.get(s.row.ticker)?.sector ?? "Unclassified";
  const subsectorKeyOf = (s: (typeof withScores)[number]) =>
    refByTicker.get(s.row.ticker)?.subsector ?? refByTicker.get(s.row.ticker)?.sector ?? "Unclassified";
  const sectorRollups = rollupGroups(withScores, sectorKeyOf, (s) => s.signals.estimateBreadth, (s) => s.composite);
  const subsectorRollups = rollupGroups(
    withScores,
    subsectorKeyOf,
    (s) => s.signals.estimateBreadth,
    (s) => s.composite,
  );
  const globalMeanZByGroup = new Map<string, number | null>();
  for (const [type, keyOf] of [
    ["SECTOR", sectorKeyOf],
    ["SUBSECTOR", subsectorKeyOf],
  ] as const) {
    const byKey = new Map<string, Array<number | null>>();
    for (const s of withScores) {
      const k = keyOf(s);
      const arr = byKey.get(k);
      if (arr) arr.push(s.globalComposite);
      else byKey.set(k, [s.globalComposite]);
    }
    for (const [k, vals] of byKey) globalMeanZByGroup.set(`${type}:${k}`, meanOrNull(vals));
  }

  // Prior-week globalMeanZ (from aggregatesJson) for crossing detection.
  const priorAggs = priorDate
    ? await prisma.revisionSectorAggregate.findMany({
        where: { snapshotDate: priorDate },
        select: { groupType: true, groupKey: true, aggregatesJson: true },
      })
    : [];
  const priorGlobalMeanZ = new Map<string, number | null>();
  for (const a of priorAggs) {
    const j = a.aggregatesJson as { globalMeanZ?: unknown } | null;
    priorGlobalMeanZ.set(
      `${a.groupType}:${a.groupKey}`,
      j && typeof j.globalMeanZ === "number" && Number.isFinite(j.globalMeanZ) ? j.globalMeanZ : null,
    );
  }

  for (const [type, rollups] of [
    ["SECTOR", sectorRollups],
    ["SUBSECTOR", subsectorRollups],
  ] as const) {
    for (const g of rollups) {
      const aggregatesJson = {
        globalMeanZ: globalMeanZByGroup.get(`${type}:${g.groupKey}`) ?? null,
        groupZ: decomposition.groupZByKey.get(g.groupKey) ?? null,
      } as Prisma.InputJsonValue;
      await prisma.revisionSectorAggregate.upsert({
        where: { groupType_groupKey_snapshotDate: { groupType: type, groupKey: g.groupKey, snapshotDate: latest } },
        create: {
          groupType: type,
          groupKey: g.groupKey,
          snapshotDate: latest,
          breadth: g.breadth,
          compositeMean: g.compositeMean,
          nameCount: g.nameCount,
          aggregatesJson,
        },
        update: { breadth: g.breadth, compositeMean: g.compositeMean, nameCount: g.nameCount, aggregatesJson },
      });
    }
  }

  // ---- Transition detection (weekly types) ----
  const stockMetrics: StockWeekMetrics[] = stocks.map((s, i) => {
    const d = derived[i]!;
    const peer = peers.get(s.row.ticker)!;
    const prior = priorStateByTicker.get(s.row.ticker);
    return {
      ticker: s.row.ticker,
      primaryDecile: peer.peerGroupType === "SUBSECTOR" ? subsectorDeciles[i] ?? null : sectorDeciles[i] ?? null,
      gapScore: d.gapScore,
      compositeZ: d.globalComposite, // universe scale — matches the group meanZ scale
      streak: d.streak,
      priorSide: prior?.side ?? null,
      priorStreak: prior?.streak ?? null,
      daysToEarnings: s.cur.daysToEarnings,
      peerGroupType: peer.peerGroupType,
      peerGroupKey: peer.peerGroupKey,
    };
  });
  const groupMetrics: GroupWeekMetrics[] = [];
  for (const [type, rollups] of [
    ["SECTOR", sectorRollups],
    ["SUBSECTOR", subsectorRollups],
  ] as const) {
    for (const g of rollups) {
      groupMetrics.push({
        groupType: type,
        groupKey: g.groupKey,
        meanZ: globalMeanZByGroup.get(`${type}:${g.groupKey}`) ?? null,
        priorMeanZ: priorGlobalMeanZ.get(`${type}:${g.groupKey}`) ?? null,
      });
    }
  }
  const drafts: TransitionDraft[] = [
    ...detectStockTransitions(stockMetrics),
    ...detectGroupTransitions(groupMetrics, stockMetrics),
  ];
  const transitionsWritten = await writeWeeklyTransitions(latest, drafts);

  // Tag this week's dominos in the queue payload.
  const dominoTickers = new Set(drafts.filter((d) => d.type === "NEXT_DOMINO").map((d) => d.ticker));
  for (const row of queueRows) {
    if (dominoTickers.has(row.ticker as string)) (row.setupTags as string[]).push("DOMINO");
  }

  // Ranked queue output cache.
  const priceCoverage =
    stocks.length > 0 ? derived.filter((d) => d.ret4w !== null).length / stocks.length : 0;
  const queuePayload = {
    snapshotDate: snapshotIso,
    generatedAt: new Date().toISOString(),
    count: queueRows.length,
    effectiveWindow: {
      legAWeeks: legADepthWeeks,
      composite4wWindow: t.composite4wWindow,
      streakSource,
      legBWeeks: rankDates.length,
      priceCoverage,
    },
    rows: queueRows,
  } as unknown as Prisma.InputJsonValue;
  await prisma.researchQueueSnapshot.upsert({
    where: { snapshotDate: latest },
    create: { snapshotDate: latest, payloadJson: queuePayload },
    update: { payloadJson: queuePayload, computedAt: new Date() },
  });

  log(
    `[scoring] scored ${scored}, ranked ${rankZ.filter((v) => v !== null).length}, new arrivals ${newArrivals}, sectors ${sectorRollups.length}, subsectors ${subsectorRollups.length}, transitions ${transitionsWritten}, legA depth ${legADepthWeeks}w, orth beta ${currentRank.beta?.toFixed(3) ?? "n/a"} on ${currentRank.regressionN} names, price coverage ${(priceCoverage * 100).toFixed(0)}%`,
  );
  return {
    snapshotDate: snapshotIso,
    priorSnapshotDate: priorDate ? isoOf(priorDate) : null,
    scored,
    newArrivals,
    sectorGroups: sectorRollups.length,
    subsectorGroups: subsectorRollups.length,
    transitionsWritten,
    legADepthWeeks,
    priceCoverage,
  };
}
