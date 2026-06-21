/**
 * factor-performance.service — per-horizon factor performance for the Market
 * Map tab's Factor Performance section.
 *
 * Mirrors the Market Map stock-grid contract (geometric compounding, signed
 * Bloomberg heat, per-horizon column ranges) so factor rows render in the
 * exact same visual format as ticker rows. Scoped to the 14 MACRO14 factors.
 */
import type { PrismaClient } from "@prisma/client";
import type { BenchmarkCode, MetricKind } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import {
  factorHorizonMetrics,
  pickFactorMetric,
} from "@/domain/calculations/factor-horizon-metrics";
import { riskFreeAnnual } from "@/infrastructure/config/env";
import { getAllFactorReturnSeries } from "./factor-engine.service";
import { loadBenchmarkSeries } from "./market-map.service";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode } from "@/types/factors";

/**
 * Trailing observations we load per factor. 320 trading bars comfortably
 * exceeds the 252-day 1Y horizon used by the Market Map grid and matches the
 * `RECENT_BARS` constant in `market-map.service`.
 */
const FACTOR_LOOKBACK_BARS = 320;

export type FactorPerformanceRow = {
  key: string;
  label: string;
  code: FactorCode;
  cells: Record<Horizon, number | null>;
};

export type FactorPerformanceResult = {
  rows: FactorPerformanceRow[];
  asOf: string | null;
  warnings: string[];
};

export async function computeFactorPerformanceMap(
  db: PrismaClient,
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<FactorPerformanceResult> {
  const warnings: string[] = [];
  const rfAnnual = riskFreeAnnual();

  const { dates, byFactor } = await getAllFactorReturnSeries(FACTOR_LOOKBACK_BARS);
  const asOf = dates.length > 0 ? dates[dates.length - 1]! : null;

  let benchDaily: number[] | null = null;
  if (metric === "EXCESS_RETURN") {
    const benchSeries = await loadBenchmarkSeries(db, benchmark);
    if (benchSeries.length < 5) {
      warnings.push(
        "Benchmark series is empty or too short. Run \u201cRefresh benchmarks\u201d on the Universe page.",
      );
    } else {
      benchDaily = dailyReturnsFromAdjustedCloses(
        benchSeries.map((r) => r.adjClose),
      );
    }
  }

  const codes = resolveModel("MACRO14").factors as FactorCode[];

  const rows: FactorPerformanceRow[] = codes.map((code) => {
    const series = byFactor.get(code) ?? [];
    const metrics = factorHorizonMetrics(series, benchDaily, rfAnnual);
    const cells = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      cells[h] = pickFactorMetric(metrics, h, metric);
    }
    return {
      key: code,
      label: getFactorDef(code).label,
      code,
      cells,
    };
  });

  return { rows, asOf, warnings };
}
