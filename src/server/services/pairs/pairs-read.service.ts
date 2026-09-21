/**
 * Pairs tab — panel read models. Nothing here computes a signal; it reads the
 * PairGroupSnapshot / PairSnapshot / PairUniverseWeek rows written by the group
 * + snapshot services, resolves the latest grid week, and shapes plain
 * serializable payloads for the routes.
 */
import { prisma } from "@/infrastructure/db/client";
import type { PairBasketWeighting } from "@prisma/client";
import { gapNoiseFloorPp, isThinGap } from "@/lib/pairs/flags";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function resolveDate(date?: string): Promise<Date | null> {
  if (date) return new Date(`${date}T00:00:00Z`);
  const max = await prisma.pairSnapshot.aggregate({ _max: { snapshotDate: true } });
  return max._max.snapshotDate ?? null;
}

export interface PairUniversePayload {
  snapshotDate: string;
  pairCount: number;
  passHedgeEff: number;
  arrivals: string[];
  exits: string[];
  vintage: { e1: string | null; e2: string | null; e3: string | null; e4: string | null };
}

export async function getPairUniverse(date?: string): Promise<PairUniversePayload | null> {
  const d = await resolveDate(date);
  if (!d) return null;
  const uw = await prisma.pairUniverseWeek.findUnique({ where: { snapshotDate: d } });
  if (!uw) return null;
  return {
    snapshotDate: isoOf(d),
    pairCount: uw.pairCount,
    passHedgeEff: uw.passHedgeEff,
    arrivals: uw.arrivals,
    exits: uw.exits,
    vintage: {
      e1: uw.e1AsOf ? isoOf(uw.e1AsOf) : null,
      e2: uw.e2AsOf ? isoOf(uw.e2AsOf) : null,
      e3: uw.e3AsOfQuarter ?? null,
      e4: uw.e4AsOf ? isoOf(uw.e4AsOf) : null,
    },
  };
}

export interface PairGroupCell {
  key: string;
  sector: string;
  nameCount: number;
  e1Breadth: number | null;
  e2Breadth: number | null;
  dispersionIqr: number | null;
  dispersionPctile5y: number | null;
  crowdingPct: number | null;
  ptUpPct: number | null;
  ptDownPct: number | null;
  e3NetBuyers: number | null;
  medianFwdMultiple: number | null;
  indexLevel: number | null;
}

const GROUP_CELL_SELECT = {
  groupKey: true,
  nameCount: true,
  e1Breadth: true,
  e2Breadth: true,
  dispersionIqr: true,
  dispersionPctile5y: true,
  crowdingPct: true,
  ptUpPct: true,
  ptDownPct: true,
  e3NetBuyers: true,
  medianFwdMultiple: true,
  indexLevel: true,
} as const;

type GroupCellRow = {
  groupKey: string;
  nameCount: number;
  e1Breadth: number | null;
  e2Breadth: number | null;
  dispersionIqr: number | null;
  dispersionPctile5y: number | null;
  crowdingPct: number | null;
  ptUpPct: number | null;
  ptDownPct: number | null;
  e3NetBuyers: number | null;
  medianFwdMultiple: number | null;
  indexLevel: number | null;
};

function toGroupCell(g: GroupCellRow, sector: string): PairGroupCell {
  return {
    key: g.groupKey,
    sector,
    nameCount: g.nameCount,
    e1Breadth: g.e1Breadth,
    e2Breadth: g.e2Breadth,
    dispersionIqr: g.dispersionIqr,
    dispersionPctile5y: g.dispersionPctile5y,
    crowdingPct: g.crowdingPct,
    ptUpPct: g.ptUpPct,
    ptDownPct: g.ptDownPct,
    e3NetBuyers: g.e3NetBuyers,
    medianFwdMultiple: g.medianFwdMultiple,
    indexLevel: g.indexLevel,
  };
}

export interface PairRowPayload {
  longKey: string;
  shortKey: string;
  groupType: string;
  crossSector: boolean;
  longSector: string | null;
  shortSector: string | null;
  longNameCount: number;
  shortNameCount: number;
  e1BreadthLong: number | null;
  e1BreadthShort: number | null;
  e1Gap: number | null;
  e1Gap4wChange: number | null;
  e1GapSeries: number[];
  e2BreadthLong: number | null;
  e2BreadthShort: number | null;
  e2Gap: number | null;
  e2Gap4wChange: number | null;
  e2GapSeries: number[];
  priceRatioSeries: number[];
  relReturn1m: number | null;
  relReturn3m: number | null;
  ewMinusCw1m: number | null;
  unpricedGap: number | null;
  unpricedGapDriver: string | null;
  unpricedGapE1: number | null;
  unpricedGapE2: number | null;
  unpricedAgree: boolean;
  unpricedGapCalibrated: boolean;
  ownObsWeeks: number;
  e2GapStepPp: number | null;
  e2GapStepAgeWeeks: number | null;
  priceRatioZ: number | null;
  hedgeEff: number | null;
  residualSharePct: number | null;
  topFactor: string | null;
  topFactorLoading: number | null;
  topFactorVarPct: number | null;
  netFactorLoadings: Record<string, number> | null;
  betaNeutralRatio: number | null;
  crowdingLong: number | null;
  crowdingShort: number | null;
  crowdBreadthLong: number | null;
  crowdBreadthShort: number | null;
  e3NetBuyersLong: number | null;
  e3NetBuyersShort: number | null;
  e3NetBuyerGap: number | null;
  valRatioPctile: number | null;
  flags: string[];
  topDecileEnteredAt: string | null;
  weeksInTopDecile: number;
  orientationFlipped: boolean;
  /** Derived (not stored): the name-equivalent gap noise floor and whether the
   *  current E1 gap sits below it. Computed from the row's own name counts so
   *  every historical week is correct with no backfill. */
  gapNoiseFloorPp: number;
  thinGap: boolean;
}

/** The raw PairSnapshot fields we read (Date / Json kept in their native type). */
interface PairSnapshotRow
  extends Omit<PairRowPayload, "netFactorLoadings" | "topDecileEnteredAt" | "gapNoiseFloorPp" | "thinGap"> {
  netFactorLoadings: unknown;
  topDecileEnteredAt: Date | null;
}

function toRow(r: PairSnapshotRow): PairRowPayload {
  const { netFactorLoadings, topDecileEnteredAt, ...rest } = r;
  const noiseFloor = gapNoiseFloorPp(r.longNameCount, r.shortNameCount);
  return {
    ...rest,
    netFactorLoadings: (netFactorLoadings as Record<string, number> | null) ?? null,
    topDecileEnteredAt: topDecileEnteredAt ? isoOf(topDecileEnteredAt) : null,
    gapNoiseFloorPp: noiseFloor,
    thinGap: isThinGap(r.e1Gap, r.longNameCount, r.shortNameCount),
  };
}

/** Matrix payload: subsector breadths (for the grid) + oriented pairs (scatter). */
export interface PairMatrixPayload {
  snapshotDate: string;
  weighting: string;
  groups: PairGroupCell[];
  pairs: PairRowPayload[];
}

export async function getPairMatrix(
  date: string | undefined,
  weighting: PairBasketWeighting,
  sector?: string,
  groupType: "SUBSECTOR" | "SECTOR" = "SUBSECTOR",
): Promise<PairMatrixPayload | null> {
  const d = await resolveDate(date);
  if (!d) return null;
  const groupRows = await prisma.pairGroupSnapshot.findMany({
    where: { snapshotDate: d, weighting, groupType },
    select: GROUP_CELL_SELECT,
  });
  // Resolve each subsector's sector from the screen-row taxonomy.
  const classRows = await prisma.revisionScreenRow.findMany({ distinct: ["subsector"], select: { subsector: true, sector: true } });
  const subToSector = new Map(classRows.map((r) => [r.subsector || "Unclassified", r.sector || "Unclassified"]));
  let groups: PairGroupCell[] = groupRows.map((g) =>
    toGroupCell(g, groupType === "SECTOR" ? g.groupKey : subToSector.get(g.groupKey) ?? "Unclassified"),
  );
  if (sector) groups = groups.filter((g) => g.sector === sector);

  const pairRows = await prisma.pairSnapshot.findMany({
    where: { snapshotDate: d, weighting, tier: "T1", groupType, ...(sector ? { longSector: sector, shortSector: sector } : {}) },
    orderBy: { e1Gap4wChange: "desc" },
  });
  return {
    snapshotDate: isoOf(d),
    weighting,
    groups: groups.sort((a, b) => a.sector.localeCompare(b.sector) || a.key.localeCompare(b.key)),
    pairs: pairRows.map((r) => toRow(r as unknown as PairSnapshotRow)),
  };
}

export interface PairRankPayload {
  snapshotDate: string;
  weighting: string;
  scope: string;
  pairs: PairRowPayload[];
}

export async function getPairRank(opts: {
  date?: string;
  weighting: PairBasketWeighting;
  tier?: "T1" | "T2";
  scope: "within" | "cross" | "all";
  minHedgeEff?: number;
  driver?: "E1" | "E2" | "BOTH";
  sector?: string;
  limit: number;
}): Promise<PairRankPayload | null> {
  const d = await resolveDate(opts.date);
  if (!d) return null;
  const where: Record<string, unknown> = { snapshotDate: d, weighting: opts.weighting, tier: opts.tier ?? "T1" };
  if (opts.scope === "within") where.crossSector = false;
  else if (opts.scope === "cross") where.crossSector = true;
  // BOTH is a real agreement predicate (both engines produced a same-direction
  // calibrated gap), not a driver value — the driver is only a magnitude
  // tiebreak. E1/E2 still filter on the display driver.
  if (opts.driver === "BOTH") where.unpricedAgree = true;
  else if (opts.driver) where.unpricedGapDriver = opts.driver;
  if (opts.minHedgeEff !== undefined) where.hedgeEff = { gte: opts.minHedgeEff };
  if (opts.sector) where.OR = [{ longSector: opts.sector }, { shortSector: opts.sector }];

  const rows = await prisma.pairSnapshot.findMany({
    where: where as never,
    orderBy: [{ e1Gap4wChange: "desc" }],
    take: opts.limit,
  });
  return {
    snapshotDate: isoOf(d),
    weighting: opts.weighting,
    scope: opts.scope,
    pairs: rows.map((r) => toRow(r as unknown as PairSnapshotRow)),
  };
}

export interface PairDispersionPayload {
  snapshotDate: string;
  weighting: string;
  groups: PairGroupCell[];
}

export async function getPairDispersion(date: string | undefined, weighting: PairBasketWeighting): Promise<PairDispersionPayload | null> {
  const d = await resolveDate(date);
  if (!d) return null;
  const groupRows = await prisma.pairGroupSnapshot.findMany({
    where: { snapshotDate: d, weighting, groupType: "SUBSECTOR" },
    select: GROUP_CELL_SELECT,
  });
  const classRows = await prisma.revisionScreenRow.findMany({ distinct: ["subsector"], select: { subsector: true, sector: true } });
  const subToSector = new Map(classRows.map((r) => [r.subsector || "Unclassified", r.sector || "Unclassified"]));
  const groups: PairGroupCell[] = groupRows.map((g) => toGroupCell(g, subToSector.get(g.groupKey) ?? "Unclassified"));
  return { snapshotDate: isoOf(d), weighting, groups };
}

export interface PairTier2Killed {
  ticker: string;
  side: string;
  reason: string;
}

export interface PairTier2Row extends PairRowPayload {
  subsector: string;
  tier2Engine: string;
  longMembers: string[];
  shortMembers: string[];
  killedNames: PairTier2Killed[];
  killScreensApplied: boolean;
}

export interface PairTier2Payload {
  snapshotDate: string;
  weighting: string;
  subsector: string;
  /** The week Engine-2 quality flags first exist; before it kills aren't applied. */
  killCutoff: string | null;
  rows: PairTier2Row[]; // one per ranking engine present that week
}

/**
 * The §8.6 Tier-2 panel for one subsector: the top-k/bottom-k spread per
 * ranking engine, with surviving members, struck-through killed names, and
 * whether kill screens were applied that week (false = unscreened pre-cutoff).
 */
export async function getPairTier2(opts: {
  date?: string;
  weighting: PairBasketWeighting;
  subsector: string;
  engine?: "E1" | "E2";
}): Promise<PairTier2Payload | null> {
  const max = await prisma.pairSnapshot.aggregate({ where: { tier: "T2" }, _max: { snapshotDate: true } });
  const d = opts.date ? new Date(`${opts.date}T00:00:00Z`) : max._max.snapshotDate;
  if (!d) return null;
  const rows = await prisma.pairSnapshot.findMany({
    where: {
      tier: "T2",
      snapshotDate: d,
      weighting: opts.weighting,
      subsector: opts.subsector,
      ...(opts.engine ? { tier2Engine: opts.engine } : {}),
    },
    orderBy: [{ tier2Engine: "asc" }],
  });
  const cutoffRow = await prisma.fundamentalScore.aggregate({ _min: { snapshotDate: true } });
  return {
    snapshotDate: isoOf(d),
    weighting: opts.weighting,
    subsector: opts.subsector,
    killCutoff: cutoffRow._min.snapshotDate ? isoOf(cutoffRow._min.snapshotDate) : null,
    rows: rows.map((r) => ({
      ...toRow(r as unknown as PairSnapshotRow),
      subsector: r.subsector ?? opts.subsector,
      tier2Engine: r.tier2Engine ?? "",
      longMembers: r.longMembers,
      shortMembers: r.shortMembers,
      killedNames: Array.isArray(r.killedNames) ? (r.killedNames as unknown as PairTier2Killed[]) : [],
      killScreensApplied: r.killScreensApplied,
    })),
  };
}

export interface PairLinkPayload {
  id: string;
  tickerA: string;
  tickerB: string;
  relationType: string;
  note: string | null;
  curatedBy: string | null;
  active: boolean;
  createdAt: string;
}

/** Tier 3 — list curated links (user-readable). */
export async function getPairLinks(includeInactive = false): Promise<PairLinkPayload[]> {
  const rows = await prisma.pairCuratedLink.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    tickerA: r.tickerA,
    tickerB: r.tickerB,
    relationType: r.relationType,
    note: r.note,
    curatedBy: r.curatedBy,
    active: r.active,
    createdAt: isoOf(r.createdAt),
  }));
}

export interface PairReadThroughPayload {
  linkId: string;
  tickerA: string;
  tickerB: string;
  relationType: string;
  note: string | null;
  snapshotDate: string | null;
  firedSide: string | null;
  firedEngine: string | null;
  firedScore: number | null;
  otherScore: number | null;
  weeksElapsed: number | null;
  status: string;
}

/**
 * Tier 3 read-through panel: the latest read-through per active link (or, for a
 * specific week, that week's state). Links with no read-through row default to
 * status NEW so every curated link is represented.
 */
export async function getPairReadThroughs(date?: string): Promise<{ snapshotDate: string | null; rows: PairReadThroughPayload[] }> {
  const links = await prisma.pairCuratedLink.findMany({ where: { active: true }, orderBy: [{ createdAt: "asc" }] });
  const d = date ? new Date(`${date}T00:00:00Z`) : null;
  const rows: PairReadThroughPayload[] = [];
  for (const link of links) {
    const rt = await prisma.pairLinkReadThrough.findFirst({
      where: { linkId: link.id, ...(d ? { snapshotDate: { lte: d } } : {}) },
      orderBy: [{ snapshotDate: "desc" }],
    });
    rows.push({
      linkId: link.id,
      tickerA: link.tickerA,
      tickerB: link.tickerB,
      relationType: link.relationType,
      note: link.note,
      snapshotDate: rt ? isoOf(rt.snapshotDate) : null,
      firedSide: rt?.firedSide ?? null,
      firedEngine: rt?.firedEngine ?? null,
      firedScore: rt?.firedScore ?? null,
      otherScore: rt?.otherScore ?? null,
      weeksElapsed: rt?.weeksElapsed ?? null,
      status: rt?.status ?? "NEW",
    });
  }
  const maxDate = rows.reduce<string | null>((acc, r) => (r.snapshotDate && (!acc || r.snapshotDate > acc) ? r.snapshotDate : acc), null);
  return { snapshotDate: maxDate, rows };
}

/** For a group/[key] drill: one group's latest cell + its constituent tickers. */
export async function getPairGroup(key: string, weighting: PairBasketWeighting, date?: string): Promise<{
  snapshotDate: string;
  group: PairGroupCell & { members: string[]; ptUpPct: number | null; ptDownPct: number | null; e3NetBuyers: number | null };
} | null> {
  const d = await resolveDate(date);
  if (!d) return null;
  const g = await prisma.pairGroupSnapshot.findFirst({
    where: { snapshotDate: d, weighting, groupKey: key },
  });
  if (!g) return null;
  const classRows = await prisma.revisionScreenRow.findMany({ distinct: ["subsector"], select: { subsector: true, sector: true } });
  const subToSector = new Map(classRows.map((r) => [r.subsector || "Unclassified", r.sector || "Unclassified"]));
  return {
    snapshotDate: isoOf(d),
    group: {
      ...toGroupCell(g, g.groupType === "SECTOR" ? g.groupKey : subToSector.get(g.groupKey) ?? "Unclassified"),
      members: g.members,
    },
  };
}
