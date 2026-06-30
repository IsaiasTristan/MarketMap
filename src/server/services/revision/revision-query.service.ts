/**
 * Engine 1 — read side. Shapes the stored snapshots/scores/aggregates into the
 * payloads the Research UI consumes (master queue, per-stock trajectory,
 * sector/subsector rotation, breadth heatmap). No mutation.
 */
import type { RevisionGroupType } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  getCompanyNamesByTicker,
  pickDisplayName,
} from "@/server/services/security-name.service";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface QueuePayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Latest ranked research queue (optionally truncated to `limit` rows), with
 * each row's `companyName` overridden from the live market-map source
 * (`Security.name`) so display names match the market map and pick up custom
 * edits immediately. Falls back to the baked name then the ticker.
 */
export async function getLatestQueue(limit?: number): Promise<QueuePayload | null> {
  const snap = await prisma.researchQueueSnapshot.findFirst({ orderBy: { snapshotDate: "desc" } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as QueuePayload;
  const rows = Array.isArray(payload.rows)
    ? limit
      ? payload.rows.slice(0, limit)
      : payload.rows
    : [];
  const tickers = rows
    .map((r) => (typeof r.ticker === "string" ? r.ticker : null))
    .filter((t): t is string => t !== null);
  const namesByTicker = await getCompanyNamesByTicker(prisma, tickers);
  const enriched = rows.map((r) => {
    const ticker = typeof r.ticker === "string" ? r.ticker : null;
    if (!ticker) return r;
    const baked = typeof r.companyName === "string" ? r.companyName : null;
    return { ...r, companyName: pickDisplayName(namesByTicker, ticker, baked) };
  });
  return { ...payload, rows: enriched };
}

export interface TrajectoryPoint {
  snapshotDate: string;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  newArrival: boolean;
  signals: Record<string, number | null>;
  epsAvg: number | null;
  ptConsensus: number | null;
}

/** Per-stock signal trajectory across all stored weeks (climb vs spike vs round-trip). */
export async function getTrajectory(ticker: string): Promise<{
  ticker: string;
  points: TrajectoryPoint[];
}> {
  const t = ticker.toUpperCase();
  const [scores, snaps] = await Promise.all([
    prisma.revisionScore.findMany({ where: { ticker: t }, orderBy: { snapshotDate: "asc" } }),
    prisma.revisionSnapshot.findMany({
      where: { ticker: t },
      orderBy: { snapshotDate: "asc" },
      select: { snapshotDate: true, epsAvg: true, ptConsensus: true },
    }),
  ]);
  const snapByDate = new Map(snaps.map((s) => [isoOf(s.snapshotDate), s]));
  const points: TrajectoryPoint[] = scores.map((sc) => {
    const date = isoOf(sc.snapshotDate);
    const sj = (sc.scoreJson as { signals?: Record<string, number | null> } | null) ?? {};
    const snap = snapByDate.get(date);
    return {
      snapshotDate: date,
      composite: sc.composite,
      rank: sc.rank,
      subsectorDecile: sc.subsectorDecile,
      newArrival: sc.newArrival,
      signals: sj.signals ?? {},
      epsAvg: snap?.epsAvg !== undefined && snap?.epsAvg !== null ? Number(snap.epsAvg) : null,
      ptConsensus:
        snap?.ptConsensus !== undefined && snap?.ptConsensus !== null ? Number(snap.ptConsensus) : null,
    };
  });
  return { ticker: t, points };
}

async function recentSnapshotDates(weeks: number): Promise<Date[]> {
  const rows = await prisma.revisionSectorAggregate.findMany({
    distinct: ["snapshotDate"],
    orderBy: { snapshotDate: "desc" },
    take: weeks,
    select: { snapshotDate: true },
  });
  return rows.map((r) => r.snapshotDate).sort((a, b) => a.getTime() - b.getTime());
}

export interface RotationPayload {
  groupType: RevisionGroupType;
  dates: string[];
  series: Array<{ groupKey: string; points: Array<{ date: string; compositeMean: number | null; breadth: number | null }> }>;
}

/** Sector/subsector composite-mean lines over the last `weeks` snapshots. */
export async function getRotation(
  groupType: RevisionGroupType,
  weeks = 52,
): Promise<RotationPayload> {
  const dates = await recentSnapshotDates(weeks);
  if (dates.length === 0) return { groupType, dates: [], series: [] };
  const rows = await prisma.revisionSectorAggregate.findMany({
    where: { groupType, snapshotDate: { in: dates } },
    orderBy: { snapshotDate: "asc" },
  });
  const dateIsos = dates.map(isoOf);
  const byGroup = new Map<string, Map<string, { compositeMean: number | null; breadth: number | null }>>();
  for (const r of rows) {
    const g = byGroup.get(r.groupKey) ?? new Map();
    g.set(isoOf(r.snapshotDate), { compositeMean: r.compositeMean, breadth: r.breadth });
    byGroup.set(r.groupKey, g);
  }
  const series = [...byGroup.entries()].map(([groupKey, m]) => ({
    groupKey,
    points: dateIsos.map((date) => ({
      date,
      compositeMean: m.get(date)?.compositeMean ?? null,
      breadth: m.get(date)?.breadth ?? null,
    })),
  }));
  return { groupType, dates: dateIsos, series };
}

export type RatingChangeKind = "RATING" | "PRICE_TARGET";

export interface RatingChangeRow {
  kind: RatingChangeKind;
  ticker: string;
  companyName: string;
  sector: string | null;
  /** Event date (yyyy-MM-dd). */
  date: string;
  /** RATING fields. */
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
  /** PRICE_TARGET fields. */
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
}

export interface RatingChangesPayload {
  generatedAt: string;
  count: number;
  rows: RatingChangeRow[];
}

/** Plain (DB-free) rating event for the pure merge. */
export interface RatingEventInput {
  ticker: string;
  eventDate: Date;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
}

/** Plain (DB-free) price-target event for the pure merge. */
export interface PriceTargetEventInput {
  ticker: string;
  publishedDate: Date;
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
}

/**
 * Pure: merge rating + price-target events into one time-descending feed,
 * truncated to `limit`. `companyName`/`sector` are left as the ticker / null
 * here; the caller overlays the live display name + reference sector. Safe to
 * unit-test (no DB, no Decimal).
 */
export function mergeRatingChanges(
  ratings: RatingEventInput[],
  targets: PriceTargetEventInput[],
  limit: number,
): RatingChangeRow[] {
  const merged: Array<{ ts: number; row: RatingChangeRow }> = [];
  for (const r of ratings) {
    merged.push({
      ts: r.eventDate.getTime(),
      row: {
        kind: "RATING",
        ticker: r.ticker,
        companyName: r.ticker,
        sector: null,
        date: isoOf(r.eventDate),
        gradingCompany: r.gradingCompany,
        previousGrade: r.previousGrade,
        newGrade: r.newGrade,
        action: r.action,
        analystCompany: null,
        analystName: null,
        priceTarget: null,
        priceWhenPosted: null,
        newsPublisher: null,
      },
    });
  }
  for (const t of targets) {
    merged.push({
      ts: t.publishedDate.getTime(),
      row: {
        kind: "PRICE_TARGET",
        ticker: t.ticker,
        companyName: t.ticker,
        sector: null,
        date: isoOf(t.publishedDate),
        gradingCompany: null,
        previousGrade: null,
        newGrade: null,
        action: null,
        analystCompany: t.analystCompany,
        analystName: t.analystName,
        priceTarget: t.priceTarget,
        priceWhenPosted: t.priceWhenPosted,
        newsPublisher: t.newsPublisher,
      },
    });
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit).map((m) => m.row);
}

/**
 * Recent analyst rating changes (upgrades/downgrades) and price-target
 * revisions, merged into one time-descending feed. Reads the event-level
 * RatingEvent / PriceTargetEvent tables (tailed daily by the revision runner)
 * and overlays the live market-map display name + reference sector.
 */
export async function getRecentRatingChanges(opts: {
  ticker?: string;
  limit?: number;
}): Promise<RatingChangesPayload> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const tickerFilter = opts.ticker ? { ticker: opts.ticker.trim().toUpperCase() } : {};

  const [ratings, targets] = await Promise.all([
    prisma.ratingEvent.findMany({
      where: tickerFilter,
      orderBy: { eventDate: "desc" },
      take: limit,
    }),
    prisma.priceTargetEvent.findMany({
      where: tickerFilter,
      orderBy: { publishedDate: "desc" },
      take: limit,
    }),
  ]);

  const rows = mergeRatingChanges(
    ratings,
    targets.map((t) => ({
      ticker: t.ticker,
      publishedDate: t.publishedDate,
      analystCompany: t.analystCompany,
      analystName: t.analystName,
      priceTarget: t.priceTarget != null ? Number(t.priceTarget) : null,
      priceWhenPosted: t.priceWhenPosted != null ? Number(t.priceWhenPosted) : null,
      newsPublisher: t.newsPublisher,
    })),
    limit,
  );

  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const [namesByTicker, refs] = await Promise.all([
    getCompanyNamesByTicker(prisma, tickers),
    prisma.revisionReference.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, companyName: true, sector: true },
    }),
  ]);
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));
  for (const row of rows) {
    const ref = refByTicker.get(row.ticker);
    row.companyName = pickDisplayName(namesByTicker, row.ticker, ref?.companyName ?? null);
    row.sector = ref?.sector ?? null;
  }

  return { generatedAt: new Date().toISOString(), count: rows.length, rows };
}

export interface HeatmapPayload {
  groupType: RevisionGroupType;
  dates: string[];
  groups: string[];
  cells: Array<{ groupKey: string; values: Array<number | null> }>; // breadth per date
}

/** Breadth heatmap: groups (rows) × months (cols). */
export async function getHeatmap(
  groupType: RevisionGroupType,
  weeks = 52,
): Promise<HeatmapPayload> {
  const rot = await getRotation(groupType, weeks);
  const cells = rot.series.map((s) => ({
    groupKey: s.groupKey,
    values: s.points.map((p) => p.breadth),
  }));
  return { groupType, dates: rot.dates, groups: rot.series.map((s) => s.groupKey), cells };
}
