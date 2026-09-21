/**
 * Pairs tab — per-week group (basket) aggregates. Writes PairGroupSnapshot, the
 * building block both legs of a pair read from.
 *
 * For every weekly grid date it buckets that week's RevisionScreenRow rows into
 * SECTOR groups (all names in the sector) and SUBSECTOR groups (only subsectors
 * with >= MIN_GROUP_NAMES that week — smaller ones still count in their sector),
 * then computes, for the EQUAL and CAP weightings:
 *   - Engine 1 revision breadth from RAW ptUp/ptDown counts (never z-scores),
 *   - Engine 2 inflection breadth as-of the latest fiscal quarter (restated-basis),
 *   - within-group revision dispersion (raw winsorized values) + its 5y percentile,
 *   - a chain-linked basket total-return index from PriceHistory.adjClose,
 *   - Engine 3 net-buyer counts + crowding.
 *
 * Full recompute, in memory, in date order — deterministic and idempotent, and
 * cheap enough for the weekly revision batch (not a request path). Historical
 * weeks are stamped membershipBasis = CURRENT_TAXONOMY (§4.2): their members
 * reflect today's taxonomy, surfaced honestly rather than mixed in silently.
 */
import { prisma } from "@/infrastructure/db/client";
import type { PairMembershipBasis } from "@prisma/client";
import { weeklyCloseSeries, type EodBarLike } from "@/lib/revision/prices";
import { weeklyReturnsFromCloses } from "@/lib/pairs/spread";
import { groupBreadth, capWeightedBreadth, upDownPct, crowdBreadthPct as crowdBreadthPctOf, type BreadthMember, type BreadthDirection } from "@/lib/pairs/breadth";
import { dispersionIqr, dispersionPercentile } from "@/lib/pairs/dispersion";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { buildE2DirectionHistory, e2DirectionAsOf, type E2DirectionHistory } from "./pairs-engine2-history.service";

const PRICE_CHUNK = 300;
/** 13F is known ~45 days after quarter end; only use filings knowable by the week. */
const F13_KNOWN_LAG_DAYS = 45;

export interface PairGroupBuildResult {
  weeks: number;
  groupRows: number;
  subsectorGroups: number;
  sectorGroups: number;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ScreenRow {
  ticker: string;
  weekIso: string;
  sector: string;
  subsector: string;
  mktCap: number | null;
  ptUp: number;
  ptDown: number;
  revRaw: number | null;
}

type GroupType = "SECTOR" | "SUBSECTOR";

interface GroupWeek {
  members: string[];
  caps: Array<number | null>;
  directions: BreadthDirection[]; // Engine 1 direction per member
  revValues: Array<number | null>; // raw revision values for dispersion
  e2Members: BreadthMember[]; // Engine 2 direction members (subset with a quarter)
  e2Quarter: string | null;
  e3NetBuyers: number;
  crowdingPct: number | null;
  crowdBreadthPct: number | null;
  medianFwdMultiple: number | null;
  basketRetEqual: number | null;
  basketRetCap: number | null;
}

interface GroupState {
  type: GroupType;
  key: string;
  sector: string;
  byWeek: Map<string, GroupWeek>;
}

/** Recompute and persist all PairGroupSnapshot rows across the full grid. */
export async function computeAndWritePairGroups(
  opts: { membershipBasis?: PairMembershipBasis; log?: (m: string) => void } = {},
): Promise<PairGroupBuildResult> {
  const log = opts.log ?? (() => {});
  const membershipBasis: PairMembershipBasis = opts.membershipBasis ?? "CURRENT_TAXONOMY";

  // 1) Screen rows across the full grid.
  const rawRows = await prisma.revisionScreenRow.findMany({
    orderBy: [{ snapshotDate: "asc" }],
    select: { ticker: true, snapshotDate: true, sector: true, subsector: true, mktCap: true, ptUp: true, ptDown: true, ptRevOrthRaw: true },
  });
  if (rawRows.length === 0) {
    log("[pairs-group] no RevisionScreenRow rows — nothing to build");
    return { weeks: 0, groupRows: 0, subsectorGroups: 0, sectorGroups: 0 };
  }
  const rows: ScreenRow[] = rawRows.map((r) => ({
    ticker: r.ticker,
    weekIso: isoOf(r.snapshotDate),
    sector: r.sector || "Unclassified",
    subsector: r.subsector || r.sector || "Unclassified",
    mktCap: r.mktCap,
    ptUp: r.ptUp,
    ptDown: r.ptDown,
    revRaw: r.ptRevOrthRaw,
  }));
  const grid = [...new Set(rows.map((r) => r.weekIso))].sort();
  const gridIndex = new Map(grid.map((d, i) => [d, i]));
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  log(`[pairs-group] ${rows.length} screen rows, ${grid.length} weeks, ${tickers.length} tickers`);

  // 2) Weekly returns per ticker, sampled from daily adjClose onto the grid.
  const tickerReturns = await loadWeeklyReturns(tickers, grid, log);

  // 3) Engine 2 quarterly inflection direction history.
  const e2History = await buildE2DirectionHistory(tickers, { log });

  // 4) Engine 3 flows + Engine 2 valuation snapshots (as-of lookups).
  const e3 = await loadInstitutional(tickers);
  const valuation = await loadValuationSnapshots(tickers);

  // 5) Bucket per week into groups and compute weighting-independent aggregates.
  const groups = new Map<string, GroupState>();
  const ensure = (type: GroupType, key: string, sector: string): GroupState => {
    const id = `${type}:${key}`;
    let g = groups.get(id);
    if (!g) {
      g = { type, key, sector, byWeek: new Map() };
      groups.set(id, g);
    }
    return g;
  };

  const byWeekRows = new Map<string, ScreenRow[]>();
  for (const r of rows) {
    const arr = byWeekRows.get(r.weekIso);
    if (arr) arr.push(r);
    else byWeekRows.set(r.weekIso, [r]);
  }

  for (const week of grid) {
    const wr = byWeekRows.get(week) ?? [];
    const w = gridIndex.get(week)!;
    // Sector buckets (always) + subsector buckets (>= MIN_GROUP_NAMES).
    const bySector = new Map<string, ScreenRow[]>();
    const bySub = new Map<string, ScreenRow[]>();
    for (const r of wr) {
      (bySector.get(r.sector) ?? bySector.set(r.sector, []).get(r.sector)!).push(r);
      (bySub.get(r.subsector) ?? bySub.set(r.subsector, []).get(r.subsector)!).push(r);
    }
    for (const [key, members] of bySector) buildGroupWeek(ensure("SECTOR", key, key), week, w, members, tickerReturns, e2History, e3, valuation);
    for (const [key, members] of bySub) {
      if (members.length < PAIR_THRESHOLDS.minGroupNames) continue;
      buildGroupWeek(ensure("SUBSECTOR", key, members[0]!.sector), week, w, members, tickerReturns, e2History, e3, valuation);
    }
  }

  // 6) Chain index + dispersion percentile per group, then write rows.
  await prisma.pairGroupSnapshot.deleteMany({});
  let groupRows = 0;
  let subsectorGroups = 0;
  let sectorGroups = 0;
  const CREATE_CHUNK = 2000;
  let batch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await prisma.pairGroupSnapshot.createMany({ data: batch as never });
    groupRows += batch.length;
    batch = [];
  };

  for (const g of groups.values()) {
    if (g.type === "SUBSECTOR") subsectorGroups++;
    else sectorGroups++;
    const weeks = [...g.byWeek.keys()].sort();
    // Chain-linked index (equal + cap), anchored to 100 at the group's first week.
    let idxEqual = 100;
    let idxCap = 100;
    const iqrHistory: Array<number | null> = [];
    let first = true;
    for (const week of weeks) {
      const gw = g.byWeek.get(week)!;
      if (first) {
        first = false;
      } else {
        if (gw.basketRetEqual !== null && Number.isFinite(gw.basketRetEqual)) idxEqual *= 1 + gw.basketRetEqual;
        if (gw.basketRetCap !== null && Number.isFinite(gw.basketRetCap)) idxCap *= 1 + gw.basketRetCap;
      }
      const iqr = dispersionIqr(gw.revValues);
      iqrHistory.push(iqr);
      const pctile = dispersionPercentile(iqrHistory);

      const e1Equal = groupBreadth(memberBreadth(gw));
      const e1Cap = capWeightedBreadth(memberBreadth(gw));
      const pct = upDownPct(memberBreadth(gw));
      const e2 = gw.e2Members.length > 0 ? groupBreadth(gw.e2Members).breadth : null;

      const common = {
        groupType: g.type,
        groupKey: g.key,
        snapshotDate: new Date(`${week}T00:00:00Z`),
        membershipBasis,
        members: gw.members,
        nameCount: gw.members.length,
        ptUpPct: pct.upPct,
        ptDownPct: pct.downPct,
        e2Breadth: e2,
        e2AsOfQuarter: gw.e2Quarter ? new Date(`${gw.e2Quarter}T00:00:00Z`) : null,
        dispersionIqr: iqr,
        dispersionPctile5y: pctile,
        medianFwdMultiple: gw.medianFwdMultiple,
        e3NetBuyers: gw.e3NetBuyers,
        crowdingPct: gw.crowdingPct,
        crowdBreadthPct: gw.crowdBreadthPct,
      };
      batch.push({ ...common, weighting: "EQUAL", e1Breadth: e1Equal.breadth, indexLevel: idxEqual });
      batch.push({ ...common, weighting: "CAP", e1Breadth: e1Cap.breadth, indexLevel: idxCap });
      if (batch.length >= CREATE_CHUNK) await flush();
    }
  }
  await flush();

  log(`[pairs-group] wrote ${groupRows} rows (${sectorGroups} sector + ${subsectorGroups} subsector groups)`);
  return { weeks: grid.length, groupRows, subsectorGroups, sectorGroups };
}

function memberBreadth(gw: GroupWeek): BreadthMember[] {
  return gw.members.map((ticker, i) => ({ ticker, direction: gw.directions[i]!, marketCap: gw.caps[i] }));
}

function buildGroupWeek(
  g: GroupState,
  weekIso: string,
  weekIdx: number,
  members: ScreenRow[],
  tickerReturns: Map<string, Array<number | null>>,
  e2History: E2DirectionHistory,
  e3: Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>,
  valuation: Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>,
): void {
  const memberTickers = members.map((m) => m.ticker);
  const caps = members.map((m) => m.mktCap);
  const directions: BreadthDirection[] = members.map((m) => (m.ptUp > m.ptDown ? 1 : m.ptDown > m.ptUp ? -1 : 0));
  const revValues = members.map((m) => m.revRaw);

  // Engine 2 direction as-of this week.
  const e2Members: BreadthMember[] = [];
  let e2Quarter: string | null = null;
  for (const m of members) {
    const d = e2DirectionAsOf(e2History, m.ticker, weekIso);
    if (d) {
      e2Members.push({ ticker: m.ticker, direction: d.direction });
      if (!e2Quarter || d.quarterEnd > e2Quarter) e2Quarter = d.quarterEnd;
    }
  }

  // Engine 3 net buyers + crowding, from the latest filing knowable by this week.
  const knownBy = isoAddDays(weekIso, -F13_KNOWN_LAG_DAYS);
  let netBuyers = 0;
  const crowdVals: number[] = [];
  for (const m of members) {
    const arr = e3.get(m.ticker);
    if (!arr) continue;
    let hit: { periodIso: string; netBuyer: number; pctOfFunds: number } | null = null;
    for (const q of arr) {
      if (q.periodIso <= knownBy) hit = q;
      else break;
    }
    if (hit) {
      netBuyers += hit.netBuyer;
      crowdVals.push(hit.pctOfFunds);
    }
  }
  const crowdingPct = crowdVals.length ? crowdVals.reduce((a, b) => a + b, 0) / crowdVals.length : null;
  // Breadth of crowding: share of names above the universe p90 (crowdNameMinPct),
  // NOT the basket mean (which averages two heavily-held names into ~5%).
  const crowdBreadthPct = crowdBreadthPctOf(crowdVals, PAIR_THRESHOLDS.crowdNameMinPct);

  // Median forward multiple from the latest valuation snapshot knowable by this week.
  const multiples: number[] = [];
  for (const m of members) {
    const arr = valuation.get(m.ticker);
    if (!arr) continue;
    let hit: number | null = null;
    for (const s of arr) {
      if (s.snapIso <= weekIso && s.evToEbitda !== null && Number.isFinite(s.evToEbitda) && s.evToEbitda > 0) hit = s.evToEbitda;
      else if (s.snapIso > weekIso) break;
    }
    if (hit !== null) multiples.push(hit);
  }
  const medianFwdMultiple = multiples.length ? median(multiples) : null;

  // Basket return this week (equal + cap) from member weekly returns at weekIdx.
  const { equal, cap } = basketReturn(memberTickers, caps, tickerReturns, weekIdx);

  g.byWeek.set(weekIso, {
    members: memberTickers,
    caps,
    directions,
    revValues,
    e2Members,
    e2Quarter,
    e3NetBuyers: netBuyers,
    crowdingPct,
    crowdBreadthPct,
    medianFwdMultiple,
    basketRetEqual: equal,
    basketRetCap: cap,
  });
}

function basketReturn(
  members: string[],
  caps: Array<number | null>,
  tickerReturns: Map<string, Array<number | null>>,
  weekIdx: number,
): { equal: number | null; cap: number | null } {
  let sumEq = 0;
  let nEq = 0;
  let sumCap = 0;
  let wCap = 0;
  for (let i = 0; i < members.length; i++) {
    const r = tickerReturns.get(members[i]!)?.[weekIdx];
    if (r === null || r === undefined || !Number.isFinite(r)) continue;
    sumEq += r;
    nEq++;
    const cap = caps[i];
    if (cap !== null && cap !== undefined && Number.isFinite(cap) && cap > 0) {
      sumCap += r * cap;
      wCap += cap;
    }
  }
  return { equal: nEq > 0 ? sumEq / nEq : null, cap: wCap > 0 ? sumCap / wCap : null };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const DAY_MS = 86_400_000;
function isoAddDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Weekly returns per ticker aligned to the grid, sampled from daily adjClose. */
async function loadWeeklyReturns(
  tickers: string[],
  grid: string[],
  log: (m: string) => void,
): Promise<Map<string, Array<number | null>>> {
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
      const closes = weeklyCloseSeries(arr, grid).map((w) => w.close);
      out.set(ticker, weeklyReturnsFromCloses(closes));
      priced++;
    }
  }
  log(`[pairs-group] weekly returns for ${priced}/${tickers.length} tickers`);
  return out;
}

async function loadInstitutional(
  tickers: string[],
): Promise<Map<string, Array<{ periodIso: string; netBuyer: number; pctOfFunds: number }>>> {
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

async function loadValuationSnapshots(
  tickers: string[],
): Promise<Map<string, Array<{ snapIso: string; evToEbitda: number | null }>>> {
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
