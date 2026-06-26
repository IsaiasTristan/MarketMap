/**
 * factor-performance-cache.service — read/write/precompute the universe-level
 * MACRO14 factor-performance grid (FactorPerformanceSnapshot).
 *
 * The Factors performance grid (Market Map tab) recomputes per-horizon metrics
 * for all 14 factors from the full factor-return history on every request. The
 * daily job + market-hours runner precompute it per (metric, benchmark) and
 * store the JSON blob here; the route reads the cached row and only falls back
 * to live compute on a miss (then writes through).
 *
 * Cache key: (metric, benchmark). Mirrors the market-map response shape so the
 * client can reuse the heatmap renderer.
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import type { BenchmarkCode, MetricKind } from "@/domain/entities/analytics";
import { METRIC_KINDS, BENCHMARK_CODES } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";
import {
  computeFactorPerformanceMap,
  type FactorPerformanceRow,
} from "./factor-performance.service";

export interface FactorPerformanceSnapshotPayload {
  asOf: string | null;
  warnings: string[];
  rows: FactorPerformanceRow[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
}

/** Plain per-horizon min/max range — matches the performance route's renderer. */
function columnRanges(
  rows: { cells: Record<Horizon, number | null> }[],
  horizons: readonly Horizon[],
): { min: Record<string, number>; max: Record<string, number> } {
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const h of horizons) {
    const vals = rows
      .map((r) => r.cells[h])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vals.length === 0) {
      min[h] = 0;
      max[h] = 0;
    } else {
      min[h] = Math.min(...vals);
      max[h] = Math.max(...vals);
    }
  }
  return { min, max };
}

/** Read a cached factor-performance grid for a (metric, benchmark). */
export async function readFactorPerformanceCache(
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<FactorPerformanceSnapshotPayload | null> {
  const row = await db.factorPerformanceSnapshot.findUnique({
    where: { metric_benchmark: { metric, benchmark } },
    select: { payloadJson: true },
  });
  if (!row) return null;
  return row.payloadJson as unknown as FactorPerformanceSnapshotPayload;
}

/** Upsert a cached factor-performance grid. */
export async function writeFactorPerformanceCache(
  metric: MetricKind,
  benchmark: BenchmarkCode,
  payload: FactorPerformanceSnapshotPayload,
): Promise<void> {
  const json = payload as unknown as Prisma.InputJsonValue;
  const asOfDate = payload.asOf
    ? new Date(`${payload.asOf}T00:00:00.000Z`)
    : new Date();
  await db.factorPerformanceSnapshot.upsert({
    where: { metric_benchmark: { metric, benchmark } },
    update: { payloadJson: json, asOfDate, computedAt: new Date() },
    create: { metric, benchmark, asOfDate, payloadJson: json },
  });
}

/** Live-compute the grid, build column ranges, and persist. */
export async function computeAndCacheFactorPerformance(
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<FactorPerformanceSnapshotPayload> {
  const result = await computeFactorPerformanceMap(db, metric, benchmark);
  const payload: FactorPerformanceSnapshotPayload = {
    asOf: result.asOf,
    warnings: result.warnings,
    rows: result.rows,
    columnRanges: columnRanges(result.rows, HORIZON_ORDER),
  };
  await writeFactorPerformanceCache(metric, benchmark, payload);
  return payload;
}

export interface FactorPerformancePrecomputeEntry {
  metric: MetricKind;
  benchmark: BenchmarkCode;
  status: "ok" | "error";
  asOf?: string | null;
  elapsedMs: number;
  error?: string;
}

/** Precompute + persist the grid for every (metric, benchmark). */
export async function precomputeAllFactorPerformance(): Promise<{
  entries: FactorPerformancePrecomputeEntry[];
  totalMs: number;
}> {
  const startedAt = Date.now();
  const entries: FactorPerformancePrecomputeEntry[] = [];

  for (const metric of METRIC_KINDS) {
    for (const benchmark of BENCHMARK_CODES) {
      const t0 = Date.now();
      try {
        const payload = await computeAndCacheFactorPerformance(metric, benchmark);
        entries.push({
          metric,
          benchmark,
          status: "ok",
          asOf: payload.asOf,
          elapsedMs: Date.now() - t0,
        });
      } catch (e) {
        entries.push({
          metric,
          benchmark,
          status: "error",
          elapsedMs: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { entries, totalMs: Date.now() - startedAt };
}
