/**
 * Engine 1 — read side for the three research screens (Universe → Queue →
 * Name). Every number served here comes out of RevisionScreenRow /
 * RevisionUniverseWeek, which the weekly job materialized; nothing is scored,
 * blended or z-scored at read time. That is what keeps the screen definition
 * identical to the one Validation measures.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { HISTOGRAM_MAX, HISTOGRAM_MIN, type SubsectorBreadthCell } from "@/lib/revision/screen-rows";
import { enginesAgree } from "@/lib/revision/screen-format";
import { getCompanyNamesByTicker, pickDisplayName } from "@/server/services/security-name.service";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Grid weeks the universe strip charts. */
const STRIP_WEEKS = 26;
/** Grid steps the "vs 4 weeks ago" comparisons look back. */
const LOOKBACK = 4;
/** A dot only reaches the Universe scatter once the score is this strong. */
const SCATTER_MIN_ABS_Z = 1;

export type CapBucket = "MICRO" | "SMALL" | "MID" | "LARGE";
export type CoverageBucket = "THIN" | "MID" | "DEEP";

/** Matches the market map's size language: < $300M, < $2B, < $10B, else large. */
export function capBucket(mktCap: number | null): CapBucket | null {
  if (mktCap === null || !Number.isFinite(mktCap)) return null;
  if (mktCap < 300e6) return "MICRO";
  if (mktCap < 2e9) return "SMALL";
  if (mktCap < 10e9) return "MID";
  return "LARGE";
}

export function coverageBucket(analystCount: number): CoverageBucket {
  if (analystCount <= 4) return "THIN";
  if (analystCount <= 10) return "MID";
  return "DEEP";
}

async function resolveDate(date?: string): Promise<Date | null> {
  if (date) {
    const d = new Date(`${date}T00:00:00Z`);
    const hit = await prisma.revisionUniverseWeek.findUnique({ where: { snapshotDate: d } });
    return hit ? d : null;
  }
  const latest = await prisma.revisionUniverseWeek.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  return latest?.snapshotDate ?? null;
}

// ─── Screen 1 — Universe ────────────────────────────────────────────────────

export interface UniversePayload {
  snapshotDate: string;
  availableDates: string[];
  strip: {
    pctNamesNetUp: number | null;
    pctNamesNetUpHist: Array<number | null>;
    pctNamesNetUpWow: number | null;
    ptUpTotal: number;
    ptDownTotal: number;
    ptUpTotal4wAgo: number | null;
    ptDownTotal4wAgo: number | null;
    namesScored: number;
  };
  histogram: { bins: number[]; prior4w: number[] | null; min: number; max: number };
  churn: { arrivals: string[]; exits: string[]; arrivalsShort: string[]; exitsShort: string[] };
  subsectors: SubsectorBreadthCell[];
  scatter: Array<{
    ticker: string;
    subsector: string;
    ptRevOrthZ: number;
    pxZ: number | null;
    gap: number | null;
    mktCap: number | null;
    weeksInTopDecile: number;
  }>;
  composition: {
    byCap: Array<{ bucket: string; topDecile: number; universe: number }>;
    byCoverage: Array<{ bucket: string; topDecile: number; universe: number }>;
  };
}

export async function getUniverseScreen(date?: string): Promise<UniversePayload | null> {
  const snapshotDate = await resolveDate(date);
  if (!snapshotDate) return null;

  const weeks = await prisma.revisionUniverseWeek.findMany({
    where: { snapshotDate: { lte: snapshotDate } },
    orderBy: { snapshotDate: "desc" },
    take: STRIP_WEEKS,
  });
  const ordered = [...weeks].reverse();
  const current = ordered[ordered.length - 1]!;
  const prior = ordered[ordered.length - 2] ?? null;
  const prior4w = ordered.length > LOOKBACK ? ordered[ordered.length - 1 - LOOKBACK]! : null;

  const rows = await prisma.revisionScreenRow.findMany({
    where: { snapshotDate },
    select: {
      ticker: true,
      subsector: true,
      ptRevOrthZ: true,
      pxZ: true,
      gap: true,
      mktCap: true,
      analystCount: true,
      weeksInTopDecile: true,
      decile: true,
    },
  });

  const bucketCounts = (
    keyOf: (r: (typeof rows)[number]) => string | null,
    order: string[],
  ) => {
    const top = new Map<string, number>();
    const all = new Map<string, number>();
    for (const r of rows) {
      const k = keyOf(r);
      if (k === null) continue;
      all.set(k, (all.get(k) ?? 0) + 1);
      if (r.decile === 10) top.set(k, (top.get(k) ?? 0) + 1);
    }
    return order
      .filter((b) => (all.get(b) ?? 0) > 0)
      .map((bucket) => ({
        bucket,
        topDecile: top.get(bucket) ?? 0,
        universe: all.get(bucket) ?? 0,
      }));
  };

  return {
    snapshotDate: isoOf(snapshotDate),
    availableDates: ordered.map((w) => isoOf(w.snapshotDate)),
    strip: {
      pctNamesNetUp: current.pctNamesNetUp,
      pctNamesNetUpHist: ordered.map((w) => w.pctNamesNetUp),
      pctNamesNetUpWow:
        current.pctNamesNetUp !== null && prior?.pctNamesNetUp != null
          ? current.pctNamesNetUp - prior.pctNamesNetUp
          : null,
      ptUpTotal: current.ptUpTotal,
      ptDownTotal: current.ptDownTotal,
      ptUpTotal4wAgo: prior4w?.ptUpTotal ?? null,
      ptDownTotal4wAgo: prior4w?.ptDownTotal ?? null,
      namesScored: current.namesScored,
    },
    histogram: {
      bins: current.revZHistogram,
      prior4w: prior4w?.revZHistogram ?? null,
      min: HISTOGRAM_MIN,
      max: HISTOGRAM_MAX,
    },
    churn: {
      arrivals: current.arrivals,
      exits: current.exits,
      arrivalsShort: current.arrivalsShort,
      exitsShort: current.exitsShort,
    },
    subsectors: (current.subsectorsJson as unknown as SubsectorBreadthCell[]) ?? [],
    scatter: rows
      .filter((r) => r.ptRevOrthZ !== null && Math.abs(r.ptRevOrthZ) >= SCATTER_MIN_ABS_Z)
      .map((r) => ({
        ticker: r.ticker,
        subsector: r.subsector,
        ptRevOrthZ: r.ptRevOrthZ!,
        pxZ: r.pxZ,
        gap: r.gap,
        mktCap: r.mktCap,
        weeksInTopDecile: r.weeksInTopDecile,
      })),
    composition: {
      byCap: bucketCounts((r) => capBucket(r.mktCap), ["MICRO", "SMALL", "MID", "LARGE"]),
      byCoverage: bucketCounts((r) => coverageBucket(r.analystCount), ["THIN", "MID", "DEEP"]),
    },
  };
}

// ─── Screen 2 — Queue ───────────────────────────────────────────────────────

export interface QueueFilters {
  date?: string;
  side: "long" | "short" | "both";
  minZ: number;
  cap?: CapBucket;
  cov?: CoverageBucket;
  minWeeks?: number;
  er?: number;
  isNew?: boolean;
  /** Require at least two of e2/e3/e4 to agree in direction. */
  tri?: boolean;
  subsector?: string;
  q?: string;
  page: number;
  pageSize: number;
}

export interface ScreenRowDto {
  ticker: string;
  companyName: string | null;
  subsector: string;
  sector: string;
  mktCap: number | null;
  analystCount: number;
  ptRevOrthZ: number | null;
  ptRevOrthRaw: number | null;
  ptUp: number;
  ptDown: number;
  epsFy1Chg4w: number | null;
  revFy1Chg4w: number | null;
  ratingUp: number;
  ratingDown: number;
  ratingInit: number;
  pxZ: number | null;
  gap: number | null;
  decile: number | null;
  weeksInTopDecile: number;
  ptRevOrthZHist: number[];
  decileHist: number[];
  isNewTop: boolean;
  isNewBottom: boolean;
  daysToEarnings: number | null;
  grpZ: number | null;
  idioZ: number | null;
  e2Tag: string | null;
  e3Tag: string | null;
  e4Tag: string | null;
}

export interface QueueScreenPayload {
  snapshotDate: string;
  total: number;
  page: number;
  pageSize: number;
  rows: ScreenRowDto[];
  subsectors: string[];
}

export async function getQueueScreen(filters: QueueFilters): Promise<QueueScreenPayload | null> {
  const snapshotDate = await resolveDate(filters.date);
  if (!snapshotDate) return null;

  const where: Prisma.RevisionScreenRowWhereInput = { snapshotDate, ptRevOrthZ: { not: null } };
  if (filters.side === "long") where.ptRevOrthZ = { gte: filters.minZ };
  else if (filters.side === "short") where.ptRevOrthZ = { lte: -filters.minZ };
  if (filters.subsector) where.subsector = filters.subsector;
  if (filters.q) where.ticker = { startsWith: filters.q.toUpperCase() };
  if (filters.minWeeks) where.weeksInTopDecile = { gte: filters.minWeeks };
  if (filters.er !== undefined) where.daysToEarnings = { lte: filters.er, not: null };
  if (filters.isNew) where.OR = [{ isNewTop: true }, { isNewBottom: true }];
  if (filters.cov) {
    const ranges: Record<CoverageBucket, Prisma.IntFilter> = {
      THIN: { gte: 1, lte: 4 },
      MID: { gte: 5, lte: 10 },
      DEEP: { gte: 11 },
    };
    where.analystCount = ranges[filters.cov];
  }
  if (filters.cap) {
    const ranges: Record<CapBucket, Prisma.FloatNullableFilter> = {
      MICRO: { lt: 300e6 },
      SMALL: { gte: 300e6, lt: 2e9 },
      MID: { gte: 2e9, lt: 10e9 },
      LARGE: { gte: 10e9 },
    };
    where.mktCap = ranges[filters.cap];
  }

  // `side: both` interleaves by |z|, and the two-engine filter reads three
  // nullable tags — neither expresses in SQL, so those two run in memory over
  // the already-filtered week (a week is ~2,900 rows).
  const needsMemorySort = filters.side === "both" || filters.tri === true;
  const all = await prisma.revisionScreenRow.findMany({
    where,
    orderBy: filters.side === "short" ? { ptRevOrthZ: "asc" } : { ptRevOrthZ: "desc" },
  });

  let rows = all;
  if (filters.side === "both") {
    rows = rows.filter((r) => Math.abs(r.ptRevOrthZ!) >= filters.minZ);
  }
  if (filters.tri) {
    rows = rows.filter((r) => enginesAgree([r.e2Tag, r.e3Tag, r.e4Tag]));
  }
  if (needsMemorySort && filters.side === "both") {
    rows = [...rows].sort((a, b) => Math.abs(b.ptRevOrthZ!) - Math.abs(a.ptRevOrthZ!));
  }

  const total = rows.length;
  const start = (filters.page - 1) * filters.pageSize;
  const page = rows.slice(start, start + filters.pageSize);
  const names = await getCompanyNamesByTicker(prisma, page.map((r) => r.ticker)).catch(
    () => new Map<string, string>(),
  );

  const subsectors = await prisma.revisionScreenRow.findMany({
    where: { snapshotDate },
    distinct: ["subsector"],
    select: { subsector: true },
    orderBy: { subsector: "asc" },
  });

  return {
    snapshotDate: isoOf(snapshotDate),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    rows: page.map((r) => ({
      ticker: r.ticker,
      companyName: pickDisplayName(names, r.ticker, null),
      subsector: r.subsector,
      sector: r.sector,
      mktCap: r.mktCap,
      analystCount: r.analystCount,
      ptRevOrthZ: r.ptRevOrthZ,
      ptRevOrthRaw: r.ptRevOrthRaw,
      ptUp: r.ptUp,
      ptDown: r.ptDown,
      epsFy1Chg4w: r.epsFy1Chg4w,
      revFy1Chg4w: r.revFy1Chg4w,
      ratingUp: r.ratingUp,
      ratingDown: r.ratingDown,
      ratingInit: r.ratingInit,
      pxZ: r.pxZ,
      gap: r.gap,
      decile: r.decile,
      weeksInTopDecile: r.weeksInTopDecile,
      ptRevOrthZHist: r.ptRevOrthZHist,
      decileHist: r.decileHist,
      isNewTop: r.isNewTop,
      isNewBottom: r.isNewBottom,
      daysToEarnings: r.daysToEarnings,
      grpZ: r.grpZ,
      idioZ: r.idioZ,
      e2Tag: r.e2Tag,
      e3Tag: r.e3Tag,
      e4Tag: r.e4Tag,
    })),
    subsectors: subsectors.map((s) => s.subsector),
  };
}
