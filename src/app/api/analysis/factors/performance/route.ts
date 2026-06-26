/**
 * GET /api/analysis/factors/performance
 *
 * Per-horizon performance for the MACRO14 factor set, formatted to match the
 * Market Map stock-grid response so the client can reuse the same heatmap
 * rendering. Driven by the Market Map tab's Metric + Benchmark controls.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorPerformanceQuery } from "@/lib/api/schemas";
import {
  readFactorPerformanceCache,
  computeAndCacheFactorPerformance,
} from "@/server/services/factor-performance-cache.service";
import type { BenchmarkCode, MetricKind } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";

export const maxDuration = 30;

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

  // Read-first from the precomputed snapshot; cold miss computes + writes through.
  const payload =
    (await readFactorPerformanceCache(metric, benchmark)) ??
    (await computeAndCacheFactorPerformance(metric, benchmark));

  return NextResponse.json({
    ok: true,
    metric,
    benchmark,
    asOf: payload.asOf,
    warnings: payload.warnings,
    horizons: HORIZON_ORDER,
    columnRanges: payload.columnRanges,
    rows: payload.rows,
  });
}
