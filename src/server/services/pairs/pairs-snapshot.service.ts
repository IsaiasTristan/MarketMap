/**
 * Pairs tab — oriented Tier-1 pair snapshots. Reads the PairGroupSnapshot rows
 * written by pairs-group.service and, per weighting, builds:
 *   - within-sector subsector-vs-subsector pairs, and
 *   - sector-vs-sector pairs (cross-sector, shown behind the scope toggle).
 *
 * Each pair is oriented so the long leg is the side the ranking signal favours
 * (higher revision breadth in the latest week), applied consistently across the
 * whole history so the long-minus-short series is coherent. For every week it
 * stores the §5 metrics — breadth gaps + 13-week series, Engine 2/3 gaps,
 * relative returns + price ratio, the unpriced gap (calibrated only past the
 * pair's own 52-week history), a MACRO14 factor decomposition of the weekly
 * spread (residual share / net loadings / top factor / hedge efficiency /
 * beta-neutral ratio), valuation percentile, flags, and top-decile tracking —
 * plus a PairUniverseWeek row per grid date. Full recompute; idempotent.
 */
import { prisma } from "@/infrastructure/db/client";
import type { PairBasketWeighting } from "@prisma/client";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { weeklyReturnsFromCloses, priceRatioSeries, priceRatioZ, hedgeEfficiency } from "@/lib/pairs/spread";
import { breadthGap } from "@/lib/pairs/breadth";
import { computeUnpricedGap, unpricedEnginesAgree, stepSeries, triangulatedWeeks } from "@/lib/pairs/unpriced-gap";
import { computePairFlags, type PairFlagId, type PairFlagInputs } from "@/lib/pairs/flags";
import {
  decomposeSpread,
  loadWeeklyFactorReturns,
  trailingRel,
  tailSeries,
  sliceWin,
  valuationPercentile,
} from "./pairs-metrics";

const WEIGHTINGS: PairBasketWeighting[] = ["EQUAL", "CAP"];

export interface PairSnapshotBuildResult {
  weeks: number;
  pairRows: number;
  latestWeek: string | null;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface GroupSeries {
  type: "SECTOR" | "SUBSECTOR";
  key: string;
  sector: string;
  e1: Array<number | null>;
  e2: Array<number | null>;
  index: Array<number | null>;
  e3NetBuyers: Array<number | null>;
  crowding: Array<number | null>;
  crowdBreadth: Array<number | null>;
  fwdMultiple: Array<number | null>;
  nameCount: Array<number | null>;
}

/** Recompute and persist all PairSnapshot + PairUniverseWeek rows. */
export async function computeAndWritePairSnapshots(
  opts: { log?: (m: string) => void } = {},
): Promise<PairSnapshotBuildResult> {
  const log = opts.log ?? (() => {});

  // subsector -> sector map (PairGroupSnapshot stores only the key).
  const classRows = await prisma.revisionScreenRow.findMany({
    distinct: ["subsector"],
    select: { subsector: true, sector: true },
  });
  const subToSector = new Map<string, string>();
  for (const r of classRows) subToSector.set(r.subsector || "Unclassified", r.sector || "Unclassified");

  const groupRows = await prisma.pairGroupSnapshot.findMany({
    orderBy: [{ snapshotDate: "asc" }],
    select: {
      groupType: true,
      groupKey: true,
      weighting: true,
      snapshotDate: true,
      e1Breadth: true,
      e2Breadth: true,
      indexLevel: true,
      e3NetBuyers: true,
      crowdingPct: true,
      crowdBreadthPct: true,
      medianFwdMultiple: true,
      nameCount: true,
    },
  });
  if (groupRows.length === 0) {
    log("[pairs-snap] no PairGroupSnapshot rows — nothing to build");
    return { weeks: 0, pairRows: 0, latestWeek: null };
  }
  const grid = [...new Set(groupRows.map((r) => isoOf(r.snapshotDate)))].sort();
  const gridIndex = new Map(grid.map((d, i) => [d, i]));
  const latestWeek = grid[grid.length - 1]!;

  // Weekly MACRO14 factor return matrix aligned to the grid.
  const factorWeekly = await loadWeeklyFactorReturns(grid);

  await prisma.pairSnapshot.deleteMany({});
  await prisma.pairUniverseWeek.deleteMany({});

  // Universe-week accumulators (from the EQUAL weighting, the primary view).
  const uni = new Map<string, { pairs: Set<string>; passHedge: number; topDecile: Set<string> }>();
  for (const d of grid) uni.set(d, { pairs: new Set(), passHedge: 0, topDecile: new Set() });
  // Per-week unpriced-gap values keyed by pairKey, for decile churn.
  const weekGaps = new Map<string, Array<{ pairKey: string; gap: number }>>();
  for (const d of grid) weekGaps.set(d, []);

  let pairRows = 0;
  const CREATE_CHUNK = 1000;
  let batch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await prisma.pairSnapshot.createMany({ data: batch as never });
    pairRows += batch.length;
    batch = [];
  };

  // Build both weightings' group series up front so ewMinusCw1m can be computed
  // in the cross-weighting pass (EQUAL vs CAP for the SAME oriented pair).
  const seriesByW = new Map<PairBasketWeighting, Map<string, GroupSeries>>();
  for (const weighting of WEIGHTINGS) {
    seriesByW.set(weighting, buildGroupSeries(groupRows, weighting, grid, gridIndex, subToSector));
  }

  for (const weighting of WEIGHTINGS) {
    const series = seriesByW.get(weighting)!;
    const otherW: PairBasketWeighting = weighting === "EQUAL" ? "CAP" : "EQUAL";
    const other = seriesByW.get(otherW)!;

    // Enumerate Tier-1 pairs: within-sector subsector pairs + sector pairs.
    const subsBySector = new Map<string, GroupSeries[]>();
    const sectors: GroupSeries[] = [];
    for (const g of series.values()) {
      if (g.type === "SUBSECTOR") {
        const arr = subsBySector.get(g.sector) ?? subsBySector.set(g.sector, []).get(g.sector)!;
        arr.push(g);
      } else sectors.push(g);
    }
    const pairs: Array<{ a: GroupSeries; b: GroupSeries; cross: boolean }> = [];
    for (const [, subs] of subsBySector) {
      const sorted = [...subs].sort((x, y) => x.key.localeCompare(y.key));
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) pairs.push({ a: sorted[i]!, b: sorted[j]!, cross: false });
    }
    const sortedSectors = [...sectors].sort((x, y) => x.key.localeCompare(y.key));
    for (let i = 0; i < sortedSectors.length; i++)
      for (let j = i + 1; j < sortedSectors.length; j++) pairs.push({ a: sortedSectors[i]!, b: sortedSectors[j]!, cross: true });

    for (const { a, b, cross } of pairs) {
      const oriented = orient(a, b);
      const long = oriented.long;
      const short = oriented.short;
      const pairKey = `${long.type}:${long.key}|${short.key}`;

      const longReturns = weeklyReturnsFromCloses(long.index);
      const shortReturns = weeklyReturnsFromCloses(short.index);
      const ratio = priceRatioSeries(long.index, short.index);
      const spread = longReturns.map((r, i) => (r !== null && shortReturns[i] !== null ? r - shortReturns[i]! : null));

      const e1GapFull = long.e1.map((v, i) => breadthGap(v, short.e1[i] ?? null));
      const e2GapFull = long.e2.map((v, i) => breadthGap(v, short.e2[i] ?? null));
      const rel1mFull = grid.map((_, w) => trailingRel(longReturns, shortReturns, w, 4));
      const rel3mFull = grid.map((_, w) => trailingRel(longReturns, shortReturns, w, 13));
      // The same oriented pair under the OTHER weighting, for ewMinusCw1m.
      const otherLong = other.get(`${long.type}:${long.key}`);
      const otherShort = other.get(`${short.type}:${short.key}`);
      const otherRel1mFull =
        otherLong && otherShort
          ? (() => {
              const ol = weeklyReturnsFromCloses(otherLong.index);
              const os = weeklyReturnsFromCloses(otherShort.index);
              return grid.map((_, w) => trailingRel(ol, os, w, 4));
            })()
          : null;
      // E2 gap step (change since the last quarterly refresh), carried + expiring.
      const e2Steps = stepSeries(e2GapFull, PAIR_THRESHOLDS.e2StepMaxCarryWeeks);

      // Pass 1: compute each existing week's row + flags (sequential for orientation).
      interface PairRecord {
        w: number;
        week: string;
        flags: PairFlagId[];
        unpricedGap: number | null;
        hedgeEff: number | null;
        row: Record<string, unknown>;
      }
      const records: PairRecord[] = [];
      let priorLong: string | null = null;
      for (let w = 0; w < grid.length; w++) {
        const week = grid[w]!;
        // A pair only exists on weeks where both legs have a group snapshot.
        if (long.nameCount[w] === null || short.nameCount[w] === null) {
          priorLong = null;
          continue;
        }
        const e1Gap = e1GapFull[w] ?? null;
        const e2Gap = e2GapFull[w] ?? null;
        const e1Gap4wChange = w >= 4 && e1GapFull[w] !== null && e1GapFull[w - 4] !== null ? e1GapFull[w]! - e1GapFull[w - 4]! : null;
        const e2Gap4wChange = w >= 4 && e2GapFull[w] !== null && e2GapFull[w - 4] !== null ? e2GapFull[w]! - e2GapFull[w - 4]! : null;
        const relReturn1m = rel1mFull[w] ?? null;
        const relReturn3m = rel3mFull[w] ?? null;

        const unpriced = computeUnpricedGap(e1GapFull.slice(0, w + 1), rel1mFull.slice(0, w + 1));
        const unpricedE2 = computeUnpricedGap(e2GapFull.slice(0, w + 1), rel1mFull.slice(0, w + 1));
        const { value: unpricedGap, driver } = pickUnpriced(unpriced.value, unpricedE2.value);
        const unpricedAgree = unpricedEnginesAgree(unpriced.value, unpricedE2.value, PAIR_THRESHOLDS.unpricedAgreeMinZ);

        const ratioZ = priceRatioZ(ratio.slice(0, w + 1), PAIR_THRESHOLDS.ratioZWindowWeeks);

        // Factor decomposition of the trailing spread window.
        const decomp = decomposeSpread(spread, longReturns, shortReturns, factorWeekly, w);
        const hedgeEff = hedgeEfficiency(sliceWin(longReturns, w), sliceWin(shortReturns, w), PAIR_THRESHOLDS.hedgeEffWeeks);

        const valRatioPctile = valuationPercentile(long.fwdMultiple, short.fwdMultiple, w);

        const e2GapStepPp = e2Steps[w]!.stepPp;
        const e2GapStepAgeWeeks = e2Steps[w]!.ageWeeks;

        const flagInputs: PairFlagInputs = {
          isNewTopDecile: false, // filled in the churn pass below
          e1Gap,
          e1Gap4wChange,
          e2Gap,
          e2GapStepPp,
          relReturn1m,
          relReturn3m,
          priceRatioZ: ratioZ,
          residualSharePct: decomp.residualSharePct,
          crowdingLong: long.crowding[w] ?? null,
          crowdingShort: short.crowding[w] ?? null,
          hedgeEff,
          longNameCount: long.nameCount[w] ?? null,
          shortNameCount: short.nameCount[w] ?? null,
        };
        const flags = computePairFlags(flagInputs);

        const orientationFlipped = priorLong !== null && priorLong !== long.key;
        priorLong = long.key;

        // ewMinusCw1m, signed EQUAL - CAP regardless of which weighting we are in.
        const thisRel1m = relReturn1m;
        const otherRel1m = otherRel1mFull ? otherRel1mFull[w] ?? null : null;
        const ewMinusCw1m =
          thisRel1m !== null && otherRel1m !== null
            ? weighting === "EQUAL"
              ? thisRel1m - otherRel1m
              : otherRel1m - thisRel1m
            : null;

        records.push({
          w,
          week,
          flags,
          unpricedGap,
          hedgeEff,
          row: {
            tier: "T1",
            longKey: long.key,
            shortKey: short.key,
            groupType: long.type,
            weighting,
            snapshotDate: new Date(`${week}T00:00:00Z`),
            longSector: long.sector,
            shortSector: short.sector,
            crossSector: cross,
            longNameCount: long.nameCount[w] ?? 0,
            shortNameCount: short.nameCount[w] ?? 0,
            e1BreadthLong: long.e1[w] ?? null,
            e1BreadthShort: short.e1[w] ?? null,
            e1Gap,
            e1Gap4wChange,
            e1GapSeries: tailSeries(e1GapFull, w),
            e2BreadthLong: long.e2[w] ?? null,
            e2BreadthShort: short.e2[w] ?? null,
            e2Gap,
            e2Gap4wChange,
            e2GapSeries: tailSeries(e2GapFull, w),
            e3NetBuyersLong: long.e3NetBuyers[w] ?? null,
            e3NetBuyersShort: short.e3NetBuyers[w] ?? null,
            e3NetBuyerGap:
              long.e3NetBuyers[w] !== null && short.e3NetBuyers[w] !== null ? long.e3NetBuyers[w]! - short.e3NetBuyers[w]! : null,
            crowdingLong: long.crowding[w] ?? null,
            crowdingShort: short.crowding[w] ?? null,
            crowdBreadthLong: long.crowdBreadth[w] ?? null,
            crowdBreadthShort: short.crowdBreadth[w] ?? null,
            relReturn1m,
            relReturn3m,
            priceRatioSeries: tailSeries(ratio, w),
            priceRatioZ: ratioZ,
            unpricedGap,
            unpricedGapDriver: driver,
            unpricedGapE1: unpriced.value,
            unpricedGapE2: unpricedE2.value,
            unpricedAgree,
            unpricedGapCalibrated: unpriced.calibrated || unpricedE2.calibrated,
            ownObsWeeks: Math.max(unpriced.obsWeeks, unpricedE2.obsWeeks),
            e2GapStepPp,
            e2GapStepAgeWeeks,
            valRatioPctile,
            ewMinusCw1m,
            residualSharePct: decomp.residualSharePct,
            netFactorLoadings: decomp.loadings,
            topFactor: decomp.topFactor,
            topFactorLoading: decomp.topFactorLoading,
            topFactorVarPct: decomp.topFactorVarPct,
            hedgeEff,
            betaNeutralRatio: decomp.betaNeutralRatio,
            flags,
            topDecileEnteredAt: null,
            weeksInTopDecile: 0,
            orientationFlipped,
          },
        });
      }

      // Pass 2: TRIANGULATED across this pair's history (E1 + E2 firings within
      // +-triangulationWindowWeeks), then persist + accumulate universe/decile.
      const e1Fired = new Array<boolean>(grid.length).fill(false);
      const e2Fired = new Array<boolean>(grid.length).fill(false);
      for (const rec of records) {
        if (rec.flags.includes("UNPRICED")) e1Fired[rec.w] = true;
        if (rec.flags.includes("E2_UNPRICED")) e2Fired[rec.w] = true;
      }
      const tri = triangulatedWeeks(e1Fired, e2Fired, PAIR_THRESHOLDS.triangulationWindowWeeks);
      for (const rec of records) {
        if (tri[rec.w]) rec.flags.push("TRIANGULATED");
        if (rec.unpricedGap !== null) weekGaps.get(rec.week)!.push({ pairKey, gap: rec.unpricedGap });
        if (weighting === "EQUAL") {
          const u = uni.get(rec.week)!;
          u.pairs.add(pairKey);
          if (rec.hedgeEff !== null && rec.hedgeEff >= PAIR_THRESHOLDS.minHedgeEff) u.passHedge++;
        }
        batch.push(rec.row);
        if (batch.length >= CREATE_CHUNK) await flush();
      }
    }
  }
  await flush();

  // Top-decile churn + weeksInTopDecile from the per-week unpriced-gap ranking.
  await computeTopDecile(grid, weekGaps, uni, log);

  // Universe-week rows.
  const vintage = await loadVintages();
  for (const week of grid) {
    const u = uni.get(week)!;
    const prev = gridIndex.get(week)! > 0 ? uni.get(grid[gridIndex.get(week)! - 1]!) : undefined;
    const arrivals = [...u.topDecile].filter((k) => !prev?.topDecile.has(k));
    const exits = prev ? [...prev.topDecile].filter((k) => !u.topDecile.has(k)) : [];
    await prisma.pairUniverseWeek.create({
      data: {
        snapshotDate: new Date(`${week}T00:00:00Z`),
        weighting: "EQUAL",
        pairCount: u.pairs.size,
        stockCount: 0,
        passHedgeEff: u.passHedge,
        arrivals,
        exits,
        e1AsOf: new Date(`${latestWeek}T00:00:00Z`),
        e2AsOf: vintage.e2 ? new Date(`${vintage.e2}T00:00:00Z`) : null,
        e3AsOfQuarter: vintage.e3,
        e4AsOf: vintage.e4 ? new Date(`${vintage.e4}T00:00:00Z`) : null,
      },
    });
  }

  log(`[pairs-snap] wrote ${pairRows} pair rows over ${grid.length} weeks (latest ${latestWeek})`);
  return { weeks: grid.length, pairRows, latestWeek };
}

/** Orient a pair so the long leg is the side with the higher latest revision breadth. */
function orient(a: GroupSeries, b: GroupSeries): { long: GroupSeries; short: GroupSeries } {
  const la = lastFinite(a.e1);
  const lb = lastFinite(b.e1);
  if (la === null && lb === null) return { long: a, short: b };
  if (lb === null) return { long: a, short: b };
  if (la === null) return { long: b, short: a };
  return la >= lb ? { long: a, short: b } : { long: b, short: a };
}

function lastFinite(s: Array<number | null>): number | null {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== null && Number.isFinite(s[i]!)) return s[i]!;
  return null;
}

/**
 * The DISPLAY headline gap = the larger-magnitude engine's z-difference, and
 * which engine that was. This is a magnitude tiebreak ONLY — never a trigger and
 * never "both engines agreed" (that is `unpricedEnginesAgree`, a real predicate).
 */
function pickUnpriced(e1: number | null, e2: number | null): { value: number | null; driver: string | null } {
  if (e1 === null && e2 === null) return { value: null, driver: null };
  if (e2 === null) return { value: e1, driver: "E1" };
  if (e1 === null) return { value: e2, driver: "E2" };
  return Math.abs(e1) >= Math.abs(e2) ? { value: e1, driver: "E1" } : { value: e2, driver: "E2" };
}

function buildGroupSeries(
  rows: Array<{
    groupType: "SECTOR" | "SUBSECTOR";
    groupKey: string;
    weighting: PairBasketWeighting;
    snapshotDate: Date;
    e1Breadth: number | null;
    e2Breadth: number | null;
    indexLevel: number | null;
    e3NetBuyers: number | null;
    crowdingPct: number | null;
    crowdBreadthPct: number | null;
    medianFwdMultiple: number | null;
    nameCount: number;
  }>,
  weighting: PairBasketWeighting,
  grid: string[],
  gridIndex: Map<string, number>,
  subToSector: Map<string, string>,
): Map<string, GroupSeries> {
  const out = new Map<string, GroupSeries>();
  const blank = (): Array<number | null> => new Array(grid.length).fill(null);
  for (const r of rows) {
    if (r.weighting !== weighting) continue;
    const id = `${r.groupType}:${r.groupKey}`;
    let g = out.get(id);
    if (!g) {
      g = {
        type: r.groupType,
        key: r.groupKey,
        sector: r.groupType === "SECTOR" ? r.groupKey : subToSector.get(r.groupKey) ?? "Unclassified",
        e1: blank(),
        e2: blank(),
        index: blank(),
        e3NetBuyers: blank(),
        crowding: blank(),
        crowdBreadth: blank(),
        fwdMultiple: blank(),
        nameCount: blank(),
      };
      out.set(id, g);
    }
    const w = gridIndex.get(isoOf(r.snapshotDate));
    if (w === undefined) continue;
    g.e1[w] = r.e1Breadth;
    g.e2[w] = r.e2Breadth;
    g.index[w] = r.indexLevel;
    g.e3NetBuyers[w] = r.e3NetBuyers;
    g.crowding[w] = r.crowdingPct;
    g.crowdBreadth[w] = r.crowdBreadthPct;
    g.fwdMultiple[w] = r.medianFwdMultiple;
    g.nameCount[w] = r.nameCount;
  }
  return out;
}

async function computeTopDecile(
  grid: string[],
  weekGaps: Map<string, Array<{ pairKey: string; gap: number }>>,
  uni: Map<string, { pairs: Set<string>; passHedge: number; topDecile: Set<string> }>,
  log: (m: string) => void,
): Promise<void> {
  const enteredAt = new Map<string, string>(); // pairKey -> first-entry week (running)
  const streak = new Map<string, number>();
  const updates: Array<{ week: string; pairKey: string; enteredAt: string; weeks: number; isNew: boolean }> = [];
  for (const week of grid) {
    const arr = [...weekGaps.get(week)!].sort((a, b) => b.gap - a.gap);
    const cutoff = Math.max(1, Math.ceil(arr.length * 0.1));
    const top = new Set(arr.slice(0, cutoff).map((x) => x.pairKey));
    uni.get(week)!.topDecile = top;
    const seenThisWeek = new Set<string>();
    for (const pk of top) {
      seenThisWeek.add(pk);
      const wasIn = streak.get(pk) ?? 0;
      const isNew = wasIn === 0;
      if (isNew) enteredAt.set(pk, week);
      streak.set(pk, wasIn + 1);
      updates.push({ week, pairKey: pk, enteredAt: enteredAt.get(pk)!, weeks: streak.get(pk)!, isNew });
    }
    for (const pk of [...streak.keys()]) if (!seenThisWeek.has(pk)) streak.set(pk, 0);
  }
  // Persist top-decile tracking onto the EQUAL-weighting rows.
  let applied = 0;
  for (const u of updates) {
    const [longKey, shortKey] = splitPairKey(u.pairKey);
    const res = await prisma.pairSnapshot.updateMany({
      where: { weighting: "EQUAL", longKey, shortKey, snapshotDate: new Date(`${u.week}T00:00:00Z`) },
      data: {
        topDecileEnteredAt: new Date(`${u.enteredAt}T00:00:00Z`),
        weeksInTopDecile: u.weeks,
        flags: undefined, // leave flags as written; NEW is derived at read time from arrivals
      },
    });
    applied += res.count;
  }
  log(`[pairs-snap] top-decile tracking applied to ${applied} rows`);
}

function splitPairKey(pairKey: string): [string, string] {
  // `${type}:${longKey}|${shortKey}` — longKey may itself contain ':'? no, keys are names.
  const bar = pairKey.indexOf("|");
  const left = pairKey.slice(0, bar);
  const shortKey = pairKey.slice(bar + 1);
  const colon = left.indexOf(":");
  const longKey = left.slice(colon + 1);
  return [longKey, shortKey];
}

async function loadVintages(): Promise<{ e2: string | null; e3: string | null; e4: string | null }> {
  const [e2, e3, e4] = await Promise.all([
    prisma.pairGroupSnapshot.aggregate({ _max: { e2AsOfQuarter: true } }),
    prisma.institutionalNameAggregate.aggregate({ _max: { filingPeriod: true } }),
    prisma.factorReturnDaily.aggregate({ _max: { tradeDate: true } }),
  ]);
  return {
    e2: e2._max.e2AsOfQuarter ? isoOf(e2._max.e2AsOfQuarter) : null,
    e3: e3._max.filingPeriod ? isoOf(e3._max.filingPeriod) : null,
    e4: e4._max.tradeDate ? isoOf(e4._max.tradeDate) : null,
  };
}
