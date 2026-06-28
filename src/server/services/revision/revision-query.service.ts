/**
 * Engine 1 — read side. Shapes the stored snapshots/scores/aggregates into the
 * payloads the Research UI consumes (master queue, per-stock trajectory,
 * sector/subsector rotation, breadth heatmap). No mutation.
 */
import type { RevisionGroupType } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface QueuePayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: Array<Record<string, unknown>>;
}

/** Latest ranked research queue (optionally truncated to `limit` rows). */
export async function getLatestQueue(limit?: number): Promise<QueuePayload | null> {
  const snap = await prisma.researchQueueSnapshot.findFirst({ orderBy: { snapshotDate: "desc" } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as QueuePayload;
  if (limit && Array.isArray(payload.rows)) {
    return { ...payload, rows: payload.rows.slice(0, limit) };
  }
  return payload;
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
