/**
 * GET /api/analysis/factors/performance
 *
 * Per-horizon performance for the MACRO14 factor set, formatted to match the
 * Market Map stock-grid response so the client can reuse the same heatmap
 * rendering. Driven by the Market Map tab's Metric + Benchmark controls.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorPerformanceQuery } from "@/lib/api/schemas";
import { prisma } from "@/infrastructure/db/client";
import { computeFactorPerformanceMap } from "@/server/services/factor-performance.service";
import type { BenchmarkCode, MetricKind } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";

export const maxDuration = 30;

function columnRanges(
  rows: { cells: Record<Horizon, number | null> }[],
  horizons: readonly Horizon[],
) {
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

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorPerformanceQuery.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const metric = parsed.data.metric as MetricKind;
  const benchmark = parsed.data.benchmark as BenchmarkCode;

  const result = await computeFactorPerformanceMap(prisma, metric, benchmark);
  const ranges = columnRanges(result.rows, HORIZON_ORDER);

  return NextResponse.json({
    ok: true,
    metric,
    benchmark,
    asOf: result.asOf,
    warnings: result.warnings,
    horizons: HORIZON_ORDER,
    columnRanges: ranges,
    rows: result.rows,
  });
}
