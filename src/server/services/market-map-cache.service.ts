/**
 * market-map-cache.service — read/write/precompute the market-map grid cache
 * (MarketMapSnapshot).
 *
 * The market-map GET route recomputes the full COMPANY grid (~1,200 tickers)
 * on every request via {@link computeMarketMap} (5–28s warm). To serve warm
 * reads sub-second, the daily job + a market-hours background runner precompute
 * the COMPANY grid for each (universeId, metric, benchmark) and store the JSON
 * blob here. The route reads the cached row for non-overlay, unfiltered
 * requests and only falls back to live compute on a miss (then writes through).
 *
 * Cache key: (universeId, metric, benchmark). The client fetches the COMPANY
 * grid and aggregates sector/sub-theme cells in-browser, so COMPANY is the only
 * level cached. Sector/sub-theme filters and the extended-hours overlay bypass
 * the cache and compute live.
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import type { BenchmarkCode, MetricKind } from "@/domain/entities/analytics";
import { METRIC_KINDS, BENCHMARK_CODES } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import { percentileColumnRanges } from "@/domain/calculations/percentile-range";
import {
  computeMarketMap,
  type MarketMapApiRow,
  type ComputeMarketMapOptions,
} from "./market-map.service";

export interface MarketMapSnapshotPayload {
  asOf: string | null;
  warnings: string[];
  rows: MarketMapApiRow[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
}

/** Read a cached COMPANY-level market map for a (universe, metric, benchmark). */
export async function readMarketMapCache(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<MarketMapSnapshotPayload | null> {
  const row = await db.marketMapSnapshot.findUnique({
    where: { universeId_metric_benchmark: { universeId, metric, benchmark } },
    select: { payloadJson: true },
  });
  if (!row) return null;
  return row.payloadJson as unknown as MarketMapSnapshotPayload;
}

/** Upsert a cached COMPANY-level market map. */
export async function writeMarketMapCache(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
  payload: MarketMapSnapshotPayload,
): Promise<void> {
  const json = payload as unknown as Prisma.InputJsonValue;
  const asOfDate = payload.asOf
    ? new Date(`${payload.asOf}T00:00:00.000Z`)
    : new Date();
  await db.marketMapSnapshot.upsert({
    where: { universeId_metric_benchmark: { universeId, metric, benchmark } },
    update: { payloadJson: json, asOfDate, computedAt: new Date() },
    create: { universeId, metric, benchmark, asOfDate, payloadJson: json },
  });
}

/**
 * Live-compute the COMPANY grid (no sector/sub-theme filter), build the
 * winsorized column ranges, and persist. Returns the payload so the GET
 * route's cold-miss path can both serve and cache in one call.
 *
 * `options` carries the optional live regular-session overlay (`liveQuotes` +
 * `liveMode`) used by the REGULAR-hours runner to bake today's intraday move
 * into the same cache row. The daily job calls this with no options so the
 * official EOD close restores the clean tape.
 */
export async function computeAndCacheMarketMap(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
  options: ComputeMarketMapOptions = {},
): Promise<MarketMapSnapshotPayload> {
  const result = await computeMarketMap(
    db,
    universeId,
    metric,
    "COMPANY",
    benchmark,
    {},
    options,
  );
  const payload: MarketMapSnapshotPayload = {
    asOf: result.asOf,
    warnings: result.warnings,
    rows: result.rows,
    columnRanges: percentileColumnRanges(result.rows, HORIZON_ORDER),
  };
  await writeMarketMapCache(universeId, metric, benchmark, payload);
  return payload;
}

export interface MarketMapPrecomputeEntry {
  universeId: string;
  metric: MetricKind;
  benchmark: BenchmarkCode;
  status: "ok" | "error";
  rows?: number;
  asOf?: string | null;
  elapsedMs: number;
  error?: string;
}

/**
 * Precompute + persist the COMPANY market map for every universe ×
 * (metric, benchmark). Sequential — each compute issues a batched price query
 * and pure metric math; parallelism would mostly contend on the DB.
 */
export async function precomputeAllMarketMaps(): Promise<{
  entries: MarketMapPrecomputeEntry[];
  totalMs: number;
}> {
  const startedAt = Date.now();
  const entries: MarketMapPrecomputeEntry[] = [];
  const universes = await db.universe.findMany({ select: { id: true } });

  for (const { id: universeId } of universes) {
    for (const metric of METRIC_KINDS) {
      for (const benchmark of BENCHMARK_CODES) {
        const t0 = Date.now();
        try {
          const payload = await computeAndCacheMarketMap(
            universeId,
            metric,
            benchmark,
          );
          entries.push({
            universeId,
            metric,
            benchmark,
            status: "ok",
            rows: payload.rows.length,
            asOf: payload.asOf,
            elapsedMs: Date.now() - t0,
          });
        } catch (e) {
          entries.push({
            universeId,
            metric,
            benchmark,
            status: "error",
            elapsedMs: Date.now() - t0,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  return { entries, totalMs: Date.now() - startedAt };
}
