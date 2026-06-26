/**
 * factor-daily-precompute.service — single source of truth for the
 * "ingest latest close -> refresh factor pipeline -> precompute grids" chain.
 *
 * Consumed by:
 *   - scripts/daily-precompute.ts             (CLI / Windows Task Scheduler)
 *   - server/services/precompute-runner.ts    (server-startup catch-up)
 *
 * Idempotent — safe to call again concurrently in another process; per-row
 * upserts mean last writer wins.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  refreshBenchmarksTail,
  refreshUniverseTail,
} from "./ingest-universe.service";
import { refreshFactorPipeline } from "./factor-pipeline.service";
import { refreshMacroFactorPipeline } from "./factor-pipeline-macro.service";
import {
  precomputeAllPerStockGrids,
  type GridPrecomputeEntry,
  GRID_CACHE_MODELS,
  GRID_CACHE_WINDOWS,
} from "./factor-per-stock-cache.service";
import {
  buildRollingBetaSeries,
  writeRollingBetaCache,
} from "./factor-rolling-cache.service";
import { computeAndCacheFactorExposure } from "./factor-exposure-cache.service";
import { computeAndCacheFactorAttribution } from "./factor-attribution-cache.service";
import { persistFactorSnapshot } from "./factor-snapshot.service";
import { evaluateFactorAlerts } from "./factor-alerts.service";
import {
  precomputeAllMarketMaps,
  type MarketMapPrecomputeEntry,
} from "./market-map-cache.service";
import {
  precomputeAllFactorPerformance,
  type FactorPerformancePrecomputeEntry,
} from "./factor-performance-cache.service";
import { runFactorEngine } from "./factor-engine.service";
import type { ModelPresetName } from "@/types/factors";

export interface PortfolioFactorSnapshotEntry {
  portfolioId: string;
  model: ModelPresetName;
  window: number;
  status: "ok" | "empty" | "error";
  rollingPoints?: number;
  exposure?: boolean;
  attribution?: boolean;
  elapsedMs: number;
  error?: string;
}

export interface DailyPrecomputeSummary {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  prices: {
    bars: number;
    failures: string[];
  };
  factors: {
    ff: "fulfilled" | "rejected";
    macro: "fulfilled" | "rejected";
    ffError?: string;
    macroError?: string;
  };
  grids: GridPrecomputeEntry[];
  portfolioSnapshots: PortfolioFactorSnapshotEntry[];
  marketMaps: MarketMapPrecomputeEntry[];
  factorPerformance: FactorPerformancePrecomputeEntry[];
}

/**
 * Precompute the per-portfolio factor snapshots (rolling betas + exposure +
 * attribution) for every portfolio × (model, window) the UI can request.
 *
 * Runs `runFactorEngine` ONCE per combo and feeds all three snapshots from that
 * single result — the rolling-beta series, the exposure response, and the
 * attribution response — so the engine's regression pass is not repeated.
 * Sequential by design; each engine run is cheap relative to the per-stock grid.
 */
async function precomputeAllPortfolioFactorSnapshots(): Promise<{
  entries: PortfolioFactorSnapshotEntry[];
  totalMs: number;
}> {
  const startedAt = Date.now();
  const entries: PortfolioFactorSnapshotEntry[] = [];
  const portfolios = await prisma.portfolio.findMany({ select: { id: true } });

  for (const { id: portfolioId } of portfolios) {
    for (const model of GRID_CACHE_MODELS) {
      for (const window of GRID_CACHE_WINDOWS) {
        const t0 = Date.now();
        try {
          const engineResult = await runFactorEngine({ portfolioId, model, window });
          if (!engineResult) {
            entries.push({
              portfolioId,
              model,
              window,
              status: "empty",
              elapsedMs: Date.now() - t0,
            });
            continue;
          }
          const series = buildRollingBetaSeries(engineResult);
          await writeRollingBetaCache(portfolioId, model, window, series);
          const exposure = await computeAndCacheFactorExposure(
            portfolioId,
            model,
            window,
            engineResult,
          );
          const attribution = await computeAndCacheFactorAttribution(
            portfolioId,
            model,
            window,
            engineResult,
          );
          // Drift-snapshot persistence + alert evaluation run once per
          // (portfolio, model) at the standard 252d window — this is the
          // correct daily cadence for drift detection (previously it rode on
          // every exposure GET, which no longer runs the engine). Non-fatal.
          if (window === 252) {
            const asOfDate =
              engineResult.dates[engineResult.dates.length - 1] ??
              new Date().toISOString().slice(0, 10);
            try {
              await persistFactorSnapshot(portfolioId, asOfDate, engineResult);
              await evaluateFactorAlerts(portfolioId, model);
            } catch {
              // best-effort; drift alerts must never fail the precompute
            }
          }
          entries.push({
            portfolioId,
            model,
            window,
            status: "ok",
            rollingPoints: series.dates.length,
            exposure: !!exposure,
            attribution: !!attribution,
            elapsedMs: Date.now() - t0,
          });
        } catch (e) {
          entries.push({
            portfolioId,
            model,
            window,
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

/**
 * Run the full daily refresh chain end-to-end.
 *
 * Steps:
 *   1. Price tail refresh (benchmarks + every universe) — ingests the latest
 *      trading sessions so prices reach the last close.
 *   2. Factor pipeline refresh (Fama-French + Macro, in parallel).
 *   3. Per-stock grid precompute for every (model, window) the UI exposes.
 *   4. Per-portfolio factor snapshots (rolling betas + exposure + attribution),
 *      one engine run per portfolio × (model, window) feeding all three.
 *   5. Market-map grid snapshots for every universe × (metric, benchmark).
 *   6. Universe-level factor-performance grid for every (metric, benchmark).
 *
 * Never throws on per-step failures — failures are recorded in the summary so
 * the caller can decide what to do. Throws only on hard preconditions (no
 * universes configured, DB unavailable). The caller is expected to log.
 */
export async function runDailyPrecompute(
  opts: { tailDays?: number; log?: (msg: string) => void } = {},
): Promise<DailyPrecomputeSummary> {
  const tailDays = Math.max(1, opts.tailDays ?? 10);
  const log = opts.log ?? (() => {});
  const startedAt = new Date();
  log(`[daily-precompute] tailDays=${tailDays} starting…`);

  // --- Step 1: price tail refresh ------------------------------------------
  const universes = await prisma.universe.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (universes.length === 0) {
    throw new Error("No universes configured — nothing to refresh.");
  }

  let totalBars = 0;
  const priceFailures: string[] = [];
  try {
    const r = await refreshBenchmarksTail(prisma, tailDays);
    totalBars += r.bars;
    log(`[daily-precompute] benchmarks: ${r.bars} bars, ${r.failed.length} failed`);
    for (const f of r.failed) priceFailures.push(`benchmark:${f.code} — ${f.error}`);
  } catch (e) {
    priceFailures.push(`benchmarks — ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const u of universes) {
    try {
      const r = await refreshUniverseTail(prisma, u.id, tailDays);
      totalBars += r.bars;
      log(
        `[daily-precompute] ${u.name}: ${r.tickers} tickers, ${r.bars} bars, ${r.failed.length} failed`,
      );
      for (const f of r.failed) priceFailures.push(`${u.name}:${f.ticker} — ${f.error}`);
    } catch (e) {
      priceFailures.push(`${u.name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(
    `[daily-precompute] prices: ${totalBars} bars upserted, ${priceFailures.length} failures.`,
  );

  // --- Step 2: factor pipeline refresh -------------------------------------
  const [ff, macro] = await Promise.allSettled([
    refreshFactorPipeline(),
    refreshMacroFactorPipeline(),
  ]);
  log(
    `[daily-precompute] factor pipeline: FF=${ff.status}, macro=${macro.status}`,
  );
  if (ff.status === "rejected") log(`  FF — ${(ff.reason as Error).message}`);
  if (macro.status === "rejected") log(`  macro — ${(macro.reason as Error).message}`);

  // --- Step 3: per-stock grid precompute -----------------------------------
  const grid = await precomputeAllPerStockGrids();
  for (const e of grid.entries) {
    const detail =
      e.status === "ok"
        ? `${e.rows} rows, asOf ${e.asOfDate}`
        : e.status === "error"
          ? `ERROR ${e.error}`
          : "empty";
    log(
      `[daily-precompute] grid ${e.model} w${e.window}: ${e.status} (${detail}) in ${(e.elapsedMs / 1000).toFixed(1)}s`,
    );
  }

  // --- Step 4: per-portfolio factor snapshots (rolling + exposure + attrib) -
  const portfolioSnaps = await precomputeAllPortfolioFactorSnapshots();
  const snapsOk = portfolioSnaps.entries.filter((e) => e.status === "ok").length;
  log(
    `[daily-precompute] portfolio snapshots: ${snapsOk}/${portfolioSnaps.entries.length} portfolio×(model,window) (rolling+exposure+attribution) cached in ${(portfolioSnaps.totalMs / 1000).toFixed(1)}s.`,
  );

  // --- Step 5: market-map grid snapshots -----------------------------------
  const marketMaps = await precomputeAllMarketMaps();
  const mmOk = marketMaps.entries.filter((e) => e.status === "ok").length;
  log(
    `[daily-precompute] market maps: ${mmOk}/${marketMaps.entries.length} universe×(metric,benchmark) grids cached in ${(marketMaps.totalMs / 1000).toFixed(1)}s.`,
  );

  // --- Step 6: universe-level factor-performance grid ----------------------
  const factorPerf = await precomputeAllFactorPerformance();
  const fpOk = factorPerf.entries.filter((e) => e.status === "ok").length;
  log(
    `[daily-precompute] factor performance: ${fpOk}/${factorPerf.entries.length} (metric,benchmark) grids cached in ${(factorPerf.totalMs / 1000).toFixed(1)}s.`,
  );

  const finishedAt = new Date();
  const totalMs = finishedAt.getTime() - startedAt.getTime();
  log(
    `[daily-precompute] done in ${(totalMs / 1000).toFixed(1)}s. ${grid.entries.filter((e) => e.status === "ok").length}/${grid.entries.length} grids cached.`,
  );

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalMs,
    prices: { bars: totalBars, failures: priceFailures },
    factors: {
      ff: ff.status,
      macro: macro.status,
      ffError: ff.status === "rejected" ? (ff.reason as Error).message : undefined,
      macroError:
        macro.status === "rejected" ? (macro.reason as Error).message : undefined,
    },
    grids: grid.entries,
    portfolioSnapshots: portfolioSnaps.entries,
    marketMaps: marketMaps.entries,
    factorPerformance: factorPerf.entries,
  };
}
