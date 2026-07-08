/**
 * market-map-cache.service — read/write/precompute the market-map grid cache
 * (MarketMapSnapshot).
 *
 * A full COMPANY-grid compute via {@link computeMarketMap} (~2,900 tickers)
 * costs ~3s warm / ~13s on a cold Postgres cache (was 5–28s before the
 * float8 raw-SQL price loader, 2026-07). To serve warm
 * reads sub-second, the daily job + a market-hours background runner precompute
 * the COMPANY grid for each (universeId, metric, benchmark) and store the JSON
 * blob here. The route reads the cached row for non-overlay, unfiltered
 * requests; a stale row (marked by {@link invalidateMarketMapCache}) is served
 * as-is while {@link revalidateMarketMap} recomputes in the background
 * (stale-while-revalidate), and only a truly missing row blocks on live
 * compute + write-through.
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
  type MarketMapDiagnostics,
  type ComputeMarketMapOptions,
} from "./market-map.service";

export interface MarketMapSnapshotPayload {
  asOf: string | null;
  warnings: string[];
  rows: MarketMapApiRow[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
  /** Health counters (optional for blobs cached before this field existed). */
  diagnostics?: MarketMapDiagnostics;
  /** True when this blob was invalidated (ingest / constituent write) and a
   *  background recompute is due. Set by the read path, never stored inside
   *  the JSON blob itself. */
  stale?: boolean;
}

/** Read a cached COMPANY-level market map for a (universe, metric, benchmark). */
export async function readMarketMapCache(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<MarketMapSnapshotPayload | null> {
  const row = await db.marketMapSnapshot.findUnique({
    where: { universeId_metric_benchmark: { universeId, metric, benchmark } },
    select: { payloadJson: true, stale: true },
  });
  if (!row) return null;
  const payload = row.payloadJson as unknown as MarketMapSnapshotPayload;
  payload.stale = row.stale;
  return payload;
}

/**
 * Invalidate all cached market-map blobs for a universe (across every
 * metric/benchmark). Called on constituent writes and after a price ingest
 * that changed data. Marks the rows stale instead of deleting them so the GET
 * route can keep serving the last-known grid instantly while a background
 * recompute (stale-while-revalidate) refreshes it — deleting would force the
 * next viewer to block 5–28s on a cold compute.
 */
export async function invalidateMarketMapCache(
  universeId: string,
): Promise<void> {
  await db.marketMapSnapshot.updateMany({
    where: { universeId },
    data: { stale: true },
  });
}

/** In-flight background recomputes, keyed `${universeId}:${metric}:${benchmark}`.
 *  Single-flight guard: the 30/60s client poll (or several viewers) hitting the
 *  same stale combo must not stampede N identical 5–28s computes. */
const inflightRevalidations = new Map<string, Promise<void>>();

/**
 * Recompute + persist one (universe, metric, benchmark) combo in the
 * background, deduping concurrent callers onto the same in-flight promise.
 * Never throws — callers fire-and-forget from request handlers, so an error
 * here must not surface as an unhandled rejection; the stale flag stays set
 * and the next request retries.
 */
export function revalidateMarketMap(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
): Promise<void> {
  const key = `${universeId}:${metric}:${benchmark}`;
  const existing = inflightRevalidations.get(key);
  if (existing) return existing;
  const run = (async () => {
    try {
      await computeAndCacheMarketMap(universeId, metric, benchmark);
    } catch (e) {
      console.error(`[market-map-cache] revalidate failed for ${key}:`, e);
    } finally {
      inflightRevalidations.delete(key);
    }
  })();
  inflightRevalidations.set(key, run);
  return run;
}

/**
 * Re-warm every (metric, benchmark) combo for a universe after an
 * invalidation, hot combo (RETURN/SP500 — the UI default) first. Sequential —
 * each compute issues a batched price query + CPU-bound math; parallelism
 * would mostly contend on the DB. Fire-and-forget from the ingest route.
 */
export async function rewarmUniverse(universeId: string): Promise<void> {
  // UI default first so the grid most viewers land on refreshes soonest.
  const combos: Array<[MetricKind, BenchmarkCode]> = [["RETURN", "SP500"]];
  for (const metric of METRIC_KINDS) {
    for (const benchmark of BENCHMARK_CODES) {
      if (metric === "RETURN" && benchmark === "SP500") continue;
      combos.push([metric, benchmark]);
    }
  }
  for (const [metric, benchmark] of combos) {
    await revalidateMarketMap(universeId, metric, benchmark);
  }
}

/**
 * Whether a completed price ingest changed enough to warrant dropping the
 * market-map cache for its universe. Price ingest writes `PriceHistory`
 * directly but never touches the precomputed snapshot blob, so a backfill
 * would otherwise keep showing stale/blank cells until the daily job runs.
 * Pure so the ingest route can gate the (side-effecting) invalidation on it.
 */
export function ingestChangedMarketMap(result: {
  bars: number;
  autoDeactivated: string[];
}): boolean {
  return result.bars > 0 || result.autoDeactivated.length > 0;
}

/** Upsert a cached COMPANY-level market map. */
export async function writeMarketMapCache(
  universeId: string,
  metric: MetricKind,
  benchmark: BenchmarkCode,
  payload: MarketMapSnapshotPayload,
): Promise<void> {
  // `stale` lives on the row (set by the read path), never inside the blob —
  // strip it in case a payload was round-tripped through readMarketMapCache.
  const { stale: _stale, ...blob } = payload;
  const json = blob as unknown as Prisma.InputJsonValue;
  const asOfDate = payload.asOf
    ? new Date(`${payload.asOf}T00:00:00.000Z`)
    : new Date();
  await db.marketMapSnapshot.upsert({
    where: { universeId_metric_benchmark: { universeId, metric, benchmark } },
    update: { payloadJson: json, asOfDate, computedAt: new Date(), stale: false },
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
    diagnostics: result.diagnostics,
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
