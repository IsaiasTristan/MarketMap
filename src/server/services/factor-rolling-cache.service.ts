/**
 * factor-rolling-cache.service — build / read / write / precompute the rolling
 * factor-beta history (FactorRollingBetaSnapshot).
 *
 * The Attribution tab's "Rolling Factor Betas" chart needs a continuous series
 * of factor betas — one estimate per trading day from a trailing-window OLS.
 * The engine already produces this each request (`rollingFits`); to avoid
 * recomputing it on every page view, the daily job precomputes the series per
 * (portfolio, model, window) and stores it here. The history API serves the
 * cached row when present and only falls back to live compute on a miss.
 *
 * Cache key: (portfolioId, model, regressionWindow). One row per combo,
 * overwritten each run.
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import type { ModelPresetName } from "@/types/factors";
import {
  buildRollingBetaSeries,
  type RollingBetaSeries,
} from "@/lib/factors/regression/rolling-beta-series";
import { runFactorEngine } from "./factor-engine.service";
import { GRID_CACHE_MODELS, GRID_CACHE_WINDOWS } from "./factor-per-stock-cache.service";

export { buildRollingBetaSeries };
export type { RollingBetaSeries };

/** Read a cached rolling-beta series, or null on miss. */
export async function readRollingBetaCache(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
): Promise<RollingBetaSeries | null> {
  const row = await db.factorRollingBetaSnapshot.findUnique({
    where: {
      portfolioId_model_regressionWindow: { portfolioId, model, regressionWindow: window },
    },
    select: { seriesJson: true },
  });
  if (!row) return null;
  return row.seriesJson as unknown as RollingBetaSeries;
}

/** Upsert a cached rolling-beta series. */
export async function writeRollingBetaCache(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
  series: RollingBetaSeries,
): Promise<void> {
  const json = series as unknown as Prisma.InputJsonValue;
  const asOfDate = series.asOfDate
    ? new Date(`${series.asOfDate}T00:00:00.000Z`)
    : new Date();
  await db.factorRollingBetaSnapshot.upsert({
    where: {
      portfolioId_model_regressionWindow: { portfolioId, model, regressionWindow: window },
    },
    update: { seriesJson: json, asOfDate, computedAt: new Date() },
    create: { portfolioId, model, regressionWindow: window, asOfDate, seriesJson: json },
  });
}

export interface RollingBetaPrecomputeEntry {
  portfolioId: string;
  model: ModelPresetName;
  window: number;
  status: "ok" | "empty" | "error";
  points?: number;
  asOfDate?: string | null;
  elapsedMs: number;
  error?: string;
}

/**
 * Precompute + persist the rolling-beta series for every portfolio ×
 * (model, window) the UI can request. Sequential by design — each engine run
 * is a single regression pass and cheap relative to the per-stock grid.
 */
export async function precomputeAllPortfolioRollingBetas(): Promise<{
  entries: RollingBetaPrecomputeEntry[];
  totalMs: number;
}> {
  const startedAt = Date.now();
  const entries: RollingBetaPrecomputeEntry[] = [];

  const portfolios = await db.portfolio.findMany({ select: { id: true } });

  for (const { id: portfolioId } of portfolios) {
    for (const model of GRID_CACHE_MODELS) {
      for (const window of GRID_CACHE_WINDOWS) {
        const t0 = Date.now();
        try {
          const engineResult = await runFactorEngine({ portfolioId, model, window });
          if (!engineResult) {
            entries.push({ portfolioId, model, window, status: "empty", elapsedMs: Date.now() - t0 });
            continue;
          }
          const series = buildRollingBetaSeries(engineResult);
          await writeRollingBetaCache(portfolioId, model, window, series);
          entries.push({
            portfolioId,
            model,
            window,
            status: "ok",
            points: series.dates.length,
            asOfDate: series.asOfDate,
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
