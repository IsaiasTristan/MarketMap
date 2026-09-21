/**
 * Pairs tab — Tier 2 single-stock pairs within one subsector (brief §4.3, §6.2).
 *
 * For every weekly grid date × subsector × ranking engine (E1 revisions, E2
 * inflection) × weighting, this forms a weekly-rebalanced spread: the top-k
 * names on the engine (long) against the bottom-k (short), AFTER side-aware
 * quality kills. All per-pair metrics come from the SAME pairs-metrics helpers
 * Tier 1 uses, so a Tier-2 row is directly comparable to a Tier-1 row.
 *
 * KILL SCREENS, LABELLED HONESTLY (brief §6.2, decision 1): Engine-2 quality
 * flags only exist from the fundamental box job's first week
 * (min(FundamentalScore.snapshotDate)). Weeks at/after that cutoff apply the
 * kills and store killScreensApplied = true; earlier weeks apply NO kills,
 * store killScreensApplied = false, and are treated as an UNSCREENED population
 * that Validation never pools with screened weeks. Single-name short gates
 * (short interest / ADV / borrow) remain unavailable per the Phase-0 probe, so
 * the short side is basket-scoped and the UI says so.
 */
import { prisma } from "@/infrastructure/db/client";
import type { PairBasketWeighting } from "@prisma/client";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { priceRatioSeries, priceRatioZ, hedgeEfficiency, weeklyReturnsFromCloses } from "@/lib/pairs/spread";
import { groupBreadth, breadthGap, e1Direction, type BreadthMember } from "@/lib/pairs/breadth";
import { computeUnpricedGap, stepSeries, unpricedEnginesAgree } from "@/lib/pairs/unpriced-gap";
import { computePairFlags, type PairFlagInputs } from "@/lib/pairs/flags";
import { firstKillFlag } from "@/lib/fundamental/flags";
import { selectTopBottomK, type Tier2Member } from "@/lib/pairs/tier2";
import { weeklyCloseSeries, type EodBarLike } from "@/lib/revision/prices";
import {
  decomposeSpread,
  loadWeeklyFactorReturns,
  trailingRel,
  tailSeries,
  sliceWin,
  valuationPercentile,
} from "./pairs-metrics";
import { buildE2DirectionHistory, e2DirectionAsOf, type E2DirectionHistory } from "./pairs-engine2-history.service";

const PRICE_CHUNK = 300;
const F13_KNOWN_LAG_DAYS = 45;
const ENGINES = ["E1", "E2"] as const;
const WEIGHTINGS: PairBasketWeighting[] = ["EQUAL", "CAP"];
type Engine = (typeof ENGINES)[number];

export interface Tier2BuildResult {
  weeks: number;
  tier2Rows: number;
  screenedWeeks: number;
  killCutoff: string | null;
  latestWeek: string | null;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const DAY_MS = 86_400_000;
function isoAddDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface StockWeek {
  ticker: string;
  cap: number | null;
  ptUp: number;
  ptDown: number;
  e1Score: number | null; // ptRevOrthZ
}

/** Recompute and persist all Tier-2 PairSnapshot rows. Full recompute; idempotent. */
export async function computeAndWriteTier2Snapshots(
  opts: { log?: (m: string) => void } = {},
): Promise<Tier2BuildResult> {
  const log = opts.log ?? (() => {});

  const screenRows = await prisma.revisionScreenRow.findMany({
    orderBy: [{ snapshotDate: "asc" }],
    select: { ticker: true, snapshotDate: true, sector: true, subsector: true, mktCap: true, ptUp: true, ptDown: true, ptRevOrthZ: true },
  });
  if (screenRows.length === 0) {
    log("[pairs-t2] no RevisionScreenRow rows — nothing to build");
    return { weeks: 0, tier2Rows: 0, screenedWeeks: 0, killCutoff: null, latestWeek: null };
  }
  const grid = [...new Set(screenRows.map((r) => isoOf(r.snapshotDate)))].sort();
  const gridIndex = new Map(grid.map((d, i) => [d, i]));
  const latestWeek = grid[grid.length - 1]!;
  const tickers = [...new Set(screenRows.map((r) => r.ticker))];

  // subsector -> its sector (first seen), and per week/subsector member lists.
  const subToSector = new Map<string, string>();
  const byWeekSub = new Map<string, Map<string, StockWeek[]>>();
  for (const d of grid) byWeekSub.set(d, new Map());
  for (const r of screenRows) {
    const sector = r.sector || "Unclassified";
    const subsector = r.subsector || sector;
    if (!subToSector.has(subsector)) subToSector.set(subsector, sector);
    const wk = byWeekSub.get(isoOf(r.snapshotDate))!;
    const arr = wk.get(subsector) ?? wk.set(subsector, []).get(subsector)!;
    arr.push({ ticker: r.ticker, cap: r.mktCap, ptUp: r.ptUp, ptDown: r.ptDown, e1Score: r.ptRevOrthZ });
  }

  const tickerReturns = await loadWeeklyReturns(tickers, grid, log);
  const e2History = await buildE2DirectionHistory(tickers, { log });
  const e3 = await loadInstitutional(tickers);
  const valuation = await loadValuationSnapshots(tickers);
  const flagsHistory = await loadFlagHistory(tickers);
  const dispersion = await loadDispersion();
  const factorWeekly = await loadWeeklyFactorReturns(grid);

  const cutoffRow = await prisma.fundamentalScore.aggregate({ _min: { snapshotDate: true } });
  const killCutoff = cutoffRow._min.snapshotDate ? isoOf(cutoffRow._min.snapshotDate) : null;
  log(`[pairs-t2] kill-screen cutoff = ${killCutoff ?? "(none — all weeks unscreened)"}`);

  await prisma.pairSnapshot.deleteMany({ where: { tier: "T2" } });

  let tier2Rows = 0;
  const screenedWeeksSet = new Set<string>();
  const CREATE_CHUNK = 1000;
  let batch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await prisma.pairSnapshot.createMany({ data: batch as never });
    tier2Rows += batch.length;
    batch = [];
  };

  const subsectors = [...subToSector.keys()].sort();
  for (const subsector of subsectors) {
    const sector = subToSector.get(subsector)!;
    for (const engine of ENGINES) {
      for (const weighting of WEIGHTINGS) {
        const legs = buildLegSeries(
          subsector,
          engine,
          weighting,
          grid,
          byWeekSub,
          tickerReturns,
          e2History,
          e3,
          valuation,
          flagsHistory,
          dispersion,
          killCutoff,
        );
        if (legs.definedWeeks === 0) continue;

        const spread = legs.longRet.map((r, i) => (r !== null && legs.shortRet[i] !== null ? r - legs.shortRet[i]! : null));
        const ratio = priceRatioSeries(legs.longIndex, legs.shortIndex);
        const e1GapFull = legs.longE1.map((v, i) => breadthGap(v, legs.shortE1[i] ?? null));
        const e2GapFull = legs.longE2.map((v, i) => breadthGap(v, legs.shortE2[i] ?? null));
        // E2 gap step (change since the last quarterly refresh), carried + expiring.
        const e2Steps = stepSeries(e2GapFull, PAIR_THRESHOLDS.e2StepMaxCarryWeeks);
        const rel1mFull = grid.map((_, w) => trailingRel(legs.longRet, legs.shortRet, w, 4));
        const rel3mFull = grid.map((_, w) => trailingRel(legs.longRet, legs.shortRet, w, 13));

        for (let w = 0; w < grid.length; w++) {
          if (!legs.defined[w]) continue;
          const week = grid[w]!;
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
          const decomp = decomposeSpread(spread, legs.longRet, legs.shortRet, factorWeekly, w);
          const hedgeEff = hedgeEfficiency(sliceWin(legs.longRet, w), sliceWin(legs.shortRet, w), PAIR_THRESHOLDS.hedgeEffWeeks);
          const valRatioPctile = valuationPercentile(legs.longFwdMult, legs.shortFwdMult, w);

          const flagInputs: PairFlagInputs = {
            isNewTopDecile: false,
            e1Gap,
            e1Gap4wChange,
            e2Gap,
            e2GapStepPp: e2Steps[w]!.stepPp,
            relReturn1m,
            relReturn3m,
            priceRatioZ: ratioZ,
            residualSharePct: decomp.residualSharePct,
            crowdingLong: legs.longCrowd[w] ?? null,
            crowdingShort: legs.shortCrowd[w] ?? null,
            hedgeEff,
            longNameCount: legs.longMembers[w]!.length,
            shortNameCount: legs.shortMembers[w]!.length,
          };
          const flags = computePairFlags(flagInputs);
          const screened = legs.killScreensApplied[w]!;
          if (screened) screenedWeeksSet.add(week);

          batch.push({
            tier: "T2",
            longKey: `${subsector}#${engine}#TOP`,
            shortKey: `${subsector}#${engine}#BOT`,
            groupType: "SUBSECTOR",
            weighting,
            snapshotDate: new Date(`${week}T00:00:00Z`),
            longSector: sector,
            shortSector: sector,
            crossSector: false,
            longNameCount: legs.longMembers[w]!.length,
            shortNameCount: legs.shortMembers[w]!.length,
            e1BreadthLong: legs.longE1[w] ?? null,
            e1BreadthShort: legs.shortE1[w] ?? null,
            e1Gap,
            e1Gap4wChange,
            e1GapSeries: tailSeries(e1GapFull, w),
            e2BreadthLong: legs.longE2[w] ?? null,
            e2BreadthShort: legs.shortE2[w] ?? null,
            e2Gap,
            e2Gap4wChange,
            e2GapSeries: tailSeries(e2GapFull, w),
            e3NetBuyersLong: legs.longE3[w] ?? null,
            e3NetBuyersShort: legs.shortE3[w] ?? null,
            e3NetBuyerGap: legs.longE3[w] !== null && legs.shortE3[w] !== null ? legs.longE3[w]! - legs.shortE3[w]! : null,
            crowdingLong: legs.longCrowd[w] ?? null,
            crowdingShort: legs.shortCrowd[w] ?? null,
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
            e2GapStepPp: e2Steps[w]!.stepPp,
            e2GapStepAgeWeeks: e2Steps[w]!.ageWeeks,
            valRatioPctile,
            ewMinusCw1m: null,
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
            orientationFlipped: false,
            subsector,
            tier2Engine: engine,
            longMembers: legs.longMembers[w]!,
            shortMembers: legs.shortMembers[w]!,
            killedNames: legs.killed[w]!,
            killScreensApplied: screened,
          });
          if (batch.length >= CREATE_CHUNK) await flush();
        }
      }
    }
  }
  await flush();

  log(`[pairs-t2] wrote ${tier2Rows} Tier-2 rows over ${grid.length} weeks (${screenedWeeksSet.size} screened weeks)`);
  return { weeks: grid.length, tier2Rows, screenedWeeks: screenedWeeksSet.size, killCutoff, latestWeek };
}

interface LegSeries {
  definedWeeks: number;
  defined: boolean[];
  longRet: Array<number | null>;
  shortRet: Array<number | null>;
  longIndex: Array<number | null>;
  shortIndex: Array<number | null>;
  longE1: Array<number | null>;
  shortE1: Array<number | null>;
  longE2: Array<number | null>;
  shortE2: Array<number | null>;
  longCrowd: Array<number | null>;
  shortCrowd: Array<number | null>;
  longE3: Array<number | null>;
  shortE3: Array<number | null>;
  longFwdMult: Array<number | null>;
  shortFwdMult: Array<number | null>;
  longMembers: string[][];
  shortMembers: string[][];
  killed: Array<Array<{ ticker: string; side: string; reason: string }>>;
  killScreensApplied: boolean[];
}

function buildLegSeries(
  subsector: string,
  engine: Engine,
  weighting: PairBasketWeighting,
  grid: string[],
  byWeekSub: Map<string, Map<string, StockWeek[]>>,
  tickerReturns: Map<string, Array<number | null>>,
  e2History: E2DirectionHistory,
  e3: Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>,
  valuation: Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>,
  flagsHistory: Map<string, Array<{ snapIso: string; flags: string[] }>>,
  dispersion: Map<string, number | null>,
  killCutoff: string | null,
): LegSeries {
  const n = grid.length;
  const blank = (): Array<number | null> => new Array(n).fill(null);
  const s: LegSeries = {
    definedWeeks: 0,
    defined: new Array(n).fill(false),
    longRet: blank(),
    shortRet: blank(),
    longIndex: blank(),
    shortIndex: blank(),
    longE1: blank(),
    shortE1: blank(),
    longE2: blank(),
    shortE2: blank(),
    longCrowd: blank(),
    shortCrowd: blank(),
    longE3: blank(),
    shortE3: blank(),
    longFwdMult: blank(),
    shortFwdMult: blank(),
    longMembers: grid.map(() => []),
    shortMembers: grid.map(() => []),
    killed: grid.map(() => []),
    killScreensApplied: new Array(n).fill(false),
  };
  const k = PAIR_THRESHOLDS.tier2K;
  let longLevel: number | null = null;
  let shortLevel: number | null = null;

  for (let w = 0; w < n; w++) {
    const week = grid[w]!;
    const roster = byWeekSub.get(week)?.get(subsector) ?? [];
    const screened = killCutoff !== null && week >= killCutoff;
    s.killScreensApplied[w] = screened;

    // Dispersion gate: Tier 2 is driven off the dispersion map (§4.3).
    const pctile = dispersion.get(`${subsector}|${week}`) ?? null;
    if (roster.length < PAIR_THRESHOLDS.tier2MinSubsectorNames) {
      carryIndex(s, w, longLevel, shortLevel);
      continue;
    }
    if (pctile !== null && pctile < PAIR_THRESHOLDS.tier2MinDispersionPctile) {
      carryIndex(s, w, longLevel, shortLevel);
      continue;
    }

    const members: Tier2Member[] = [];
    for (const m of roster) {
      const score = engine === "E1" ? m.e1Score : (e2DirectionAsOf(e2History, m.ticker, week)?.magnitude ?? null);
      if (score === null || !Number.isFinite(score)) continue;
      let longKill: string | null = null;
      let shortKill: string | null = null;
      if (screened) {
        const flags = asOfFlags(flagsHistory, m.ticker, week);
        longKill = flags ? firstKillFlag(flags) : null;
        const acc = asOfE3(e3, m.ticker, week);
        if (acc !== null && acc.netBuyer > 0) shortKill = "E3 ACCUM";
      }
      members.push({ ticker: m.ticker, score, longKillReason: longKill, shortKillReason: shortKill });
    }
    if (members.length < PAIR_THRESHOLDS.tier2MinSubsectorNames) {
      carryIndex(s, w, longLevel, shortLevel);
      continue;
    }

    const sel = selectTopBottomK(members, k);
    if (!sel) {
      carryIndex(s, w, longLevel, shortLevel);
      continue;
    }

    const rosterByTicker = new Map(roster.map((m) => [m.ticker, m]));
    const longRet = basketReturn(sel.longLeg, rosterByTicker, tickerReturns, w, weighting);
    const shortRet = basketReturn(sel.shortLeg, rosterByTicker, tickerReturns, w, weighting);

    s.defined[w] = true;
    s.definedWeeks++;
    s.longRet[w] = longRet;
    s.shortRet[w] = shortRet;
    if (longLevel === null) longLevel = 100;
    else if (longRet !== null && Number.isFinite(longRet)) longLevel *= 1 + longRet;
    if (shortLevel === null) shortLevel = 100;
    else if (shortRet !== null && Number.isFinite(shortRet)) shortLevel *= 1 + shortRet;
    s.longIndex[w] = longLevel;
    s.shortIndex[w] = shortLevel;

    s.longE1[w] = groupBreadth(sideBreadthMembers(sel.longLeg, rosterByTicker)).breadth;
    s.shortE1[w] = groupBreadth(sideBreadthMembers(sel.shortLeg, rosterByTicker)).breadth;
    s.longE2[w] = e2LegBreadth(sel.longLeg, e2History, week);
    s.shortE2[w] = e2LegBreadth(sel.shortLeg, e2History, week);
    s.longCrowd[w] = legCrowd(sel.longLeg, e3, week);
    s.shortCrowd[w] = legCrowd(sel.shortLeg, e3, week);
    s.longE3[w] = legE3NetBuyers(sel.longLeg, e3, week);
    s.shortE3[w] = legE3NetBuyers(sel.shortLeg, e3, week);
    s.longFwdMult[w] = legMedianMultiple(sel.longLeg, valuation, week);
    s.shortFwdMult[w] = legMedianMultiple(sel.shortLeg, valuation, week);
    s.longMembers[w] = sel.longLeg;
    s.shortMembers[w] = sel.shortLeg;
    s.killed[w] = sel.killed.map((x) => ({ ticker: x.ticker, side: x.side, reason: x.reason }));
  }
  return s;
}

/** Carry the index level flat across an undefined week (no basket that week). */
function carryIndex(s: LegSeries, w: number, longLevel: number | null, shortLevel: number | null): void {
  s.longIndex[w] = longLevel;
  s.shortIndex[w] = shortLevel;
}

function sideBreadthMembers(leg: string[], roster: Map<string, StockWeek>): BreadthMember[] {
  return leg.map((t) => {
    const m = roster.get(t)!;
    return { ticker: t, direction: e1Direction(m.ptUp, m.ptDown), marketCap: m.cap };
  });
}

function e2LegBreadth(leg: string[], e2History: E2DirectionHistory, week: string): number | null {
  const members: BreadthMember[] = [];
  for (const t of leg) {
    const d = e2DirectionAsOf(e2History, t, week);
    if (d) members.push({ ticker: t, direction: d.direction });
  }
  return members.length > 0 ? groupBreadth(members).breadth : null;
}

function legCrowd(leg: string[], e3: Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>, week: string): number | null {
  const vals: number[] = [];
  for (const t of leg) {
    const hit = asOfE3(e3, t, week);
    if (hit) vals.push(hit.pctOfFunds);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function legE3NetBuyers(leg: string[], e3: Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>, week: string): number | null {
  let sum = 0;
  let seen = 0;
  for (const t of leg) {
    const hit = asOfE3(e3, t, week);
    if (hit) {
      sum += hit.netBuyer;
      seen++;
    }
  }
  return seen ? sum : null;
}

function legMedianMultiple(leg: string[], valuation: Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>, week: string): number | null {
  const vals: number[] = [];
  for (const t of leg) {
    const arr = valuation.get(t);
    if (!arr) continue;
    let hit: number | null = null;
    for (const sv of arr) {
      if (sv.snapIso <= week && sv.evToEbitda !== null && Number.isFinite(sv.evToEbitda) && sv.evToEbitda > 0) hit = sv.evToEbitda;
      else if (sv.snapIso > week) break;
    }
    if (hit !== null) vals.push(hit);
  }
  return vals.length ? median(vals) : null;
}

function asOfE3(
  e3: Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>,
  ticker: string,
  week: string,
): { periodIso: string; netBuyer: number; pctOfFunds: number } | null {
  const arr = e3.get(ticker);
  if (!arr) return null;
  const knownBy = isoAddDays(week, -F13_KNOWN_LAG_DAYS);
  let hit: { periodIso: string; netBuyer: number; pctOfFunds: number } | null = null;
  for (const q of arr) {
    if (q.periodIso <= knownBy) hit = q;
    else break;
  }
  return hit;
}

function asOfFlags(flagsHistory: Map<string, Array<{ snapIso: string; flags: string[] }>>, ticker: string, week: string): string[] | null {
  const arr = flagsHistory.get(ticker);
  if (!arr) return null;
  let hit: string[] | null = null;
  for (const s of arr) {
    if (s.snapIso <= week) hit = s.flags;
    else break;
  }
  return hit;
}

function basketReturn(
  leg: string[],
  roster: Map<string, StockWeek>,
  tickerReturns: Map<string, Array<number | null>>,
  w: number,
  weighting: PairBasketWeighting,
): number | null {
  let sumEq = 0;
  let nEq = 0;
  let sumCap = 0;
  let wCap = 0;
  for (const t of leg) {
    const r = tickerReturns.get(t)?.[w];
    if (r === null || r === undefined || !Number.isFinite(r)) continue;
    sumEq += r;
    nEq++;
    const cap = roster.get(t)?.cap;
    if (cap !== null && cap !== undefined && Number.isFinite(cap) && cap > 0) {
      sumCap += r * cap;
      wCap += cap;
    }
  }
  if (weighting === "CAP") return wCap > 0 ? sumCap / wCap : nEq > 0 ? sumEq / nEq : null;
  return nEq > 0 ? sumEq / nEq : null;
}

function pickUnpriced(e1: number | null, e2: number | null): { value: number | null; driver: string | null } {
  if (e1 === null && e2 === null) return { value: null, driver: null };
  if (e2 === null) return { value: e1, driver: "E1" };
  if (e1 === null) return { value: e2, driver: "E2" };
  if (Math.abs(e1 - e2) < 1e-9) return { value: (e1 + e2) / 2, driver: "BOTH" };
  return e1 >= e2 ? { value: e1, driver: "E1" } : { value: e2, driver: "E2" };
}

async function loadWeeklyReturns(tickers: string[], grid: string[], log: (m: string) => void): Promise<Map<string, Array<number | null>>> {
  const out = new Map<string, Array<number | null>>();
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  const idToTicker = new Map(secs.map((s) => [s.id, s.ticker]));
  const ids = secs.map((s) => s.id);
  const from = new Date(`${isoAddDays(grid[0]!, -20)}T00:00:00Z`);
  let priced = 0;
  for (let i = 0; i < ids.length; i += PRICE_CHUNK) {
    const chunk = ids.slice(i, i + PRICE_CHUNK);
    const bars = await prisma.priceHistory.findMany({
      where: { securityId: { in: chunk }, tradeDate: { gte: from } },
      orderBy: [{ securityId: "asc" }, { tradeDate: "asc" }],
      select: { securityId: true, tradeDate: true, adjClose: true },
    });
    const byId = new Map<string, EodBarLike[]>();
    for (const b of bars) {
      const arr = byId.get(b.securityId) ?? byId.set(b.securityId, []).get(b.securityId)!;
      arr.push({ date: isoOf(b.tradeDate), close: Number(b.adjClose) });
    }
    for (const [id, arr] of byId) {
      const ticker = idToTicker.get(id);
      if (!ticker) continue;
      const closes = weeklyCloseSeries(arr, grid).map((wk) => wk.close);
      out.set(ticker, weeklyReturnsFromCloses(closes));
      priced++;
    }
  }
  log(`[pairs-t2] weekly returns for ${priced}/${tickers.length} tickers`);
  return out;
}

async function loadInstitutional(tickers: string[]): Promise<Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>> {
  const rows = await prisma.institutionalNameAggregate.findMany({
    where: { ticker: { in: tickers } },
    orderBy: [{ ticker: "asc" }, { filingPeriod: "asc" }],
    select: { ticker: true, filingPeriod: true, fundsBought: true, fundsSold: true, pctOfFunds: true },
  });
  const out = new Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>();
  for (const r of rows) {
    const netBuyer = r.fundsBought > r.fundsSold ? 1 : r.fundsSold > r.fundsBought ? -1 : 0;
    const entry = { periodIso: isoOf(r.filingPeriod), netBuyer, pctOfFunds: r.pctOfFunds };
    const arr = out.get(r.ticker);
    if (arr) arr.push(entry);
    else out.set(r.ticker, [entry]);
  }
  return out;
}

async function loadValuationSnapshots(tickers: string[]): Promise<Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>> {
  const rows = await prisma.fundamentalSnapshot.findMany({
    where: { ticker: { in: tickers } },
    orderBy: [{ ticker: "asc" }, { snapshotDate: "asc" }],
    select: { ticker: true, snapshotDate: true, evToEbitda: true },
  });
  const out = new Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>();
  for (const r of rows) {
    const entry = { snapIso: isoOf(r.snapshotDate), evToEbitda: r.evToEbitda === null ? null : Number(r.evToEbitda) };
    const arr = out.get(r.ticker);
    if (arr) arr.push(entry);
    else out.set(r.ticker, [entry]);
  }
  return out;
}

/** Nearest-preceding FundamentalScore.scoreJson.flags per ticker, ascending by date. */
async function loadFlagHistory(tickers: string[]): Promise<Map<string, Array<{ snapIso: string; flags: string[] }>>> {
  const rows = await prisma.fundamentalScore.findMany({
    where: { ticker: { in: tickers } },
    orderBy: [{ ticker: "asc" }, { snapshotDate: "asc" }],
    select: { ticker: true, snapshotDate: true, scoreJson: true },
  });
  const out = new Map<string, Array<{ snapIso: string; flags: string[] }>>();
  for (const r of rows) {
    const json = r.scoreJson as { flags?: unknown } | null;
    const flags = Array.isArray(json?.flags) ? (json!.flags as string[]) : [];
    const entry = { snapIso: isoOf(r.snapshotDate), flags };
    const arr = out.get(r.ticker);
    if (arr) arr.push(entry);
    else out.set(r.ticker, [entry]);
  }
  return out;
}

/** subsector|week -> dispersion percentile (5y), from the EQUAL group snapshots. */
async function loadDispersion(): Promise<Map<string, number | null>> {
  const rows = await prisma.pairGroupSnapshot.findMany({
    where: { groupType: "SUBSECTOR", weighting: "EQUAL" },
    select: { groupKey: true, snapshotDate: true, dispersionPctile5y: true },
  });
  const out = new Map<string, number | null>();
  for (const r of rows) out.set(`${r.groupKey}|${isoOf(r.snapshotDate)}`, r.dispersionPctile5y);
  return out;
}
