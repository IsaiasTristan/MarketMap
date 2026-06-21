/**
 * factor-per-stock-cache.service — read/write/precompute the per-stock factor
 * grid cache (PerStockGridSnapshot).
 *
 * The Per-Stock view of the Factors tab recomputes ~300k rolling regressions
 * per request via {@link runPerStockFactors}. To make the tab load instantly,
 * a daily pre-open job precomputes the full-universe grid for every UI-visible
 * (model, window) combination and stores the JSON blob here. The API serves
 * the cached row when present and only falls back to live compute on a miss.
 *
 * Cache key: (model, regressionWindow). One row per combo, overwritten each
 * run. Sector/sub-theme filtering is applied client-side, so the cache always
 * stores the full-universe grid (no sector/subTheme in the key).
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import type { ModelPresetName } from "@/types/factors";
import { runPerStockFactors, type PerStockResult } from "./factor-per-stock.service";

/**
 * Models precomputed by the daily job. Trimmed to MACRO14 only (Jun 2026) —
 * the academic Fama-French presets remain valid via the API `model` param and
 * the live-compute fallback, but are not precomputed.
 */
export const GRID_CACHE_MODELS: ModelPresetName[] = ["MACRO14"];

/**
 * HORIZON preset windows (trading days) exposed in the Factors toolbar. Must
 * match `HORIZON_PRESETS` in FactorToolbar so every horizon the UI can select
 * is served from the precomputed grid cache (Short-Term 63 · Standard 252 ·
 * Long-Term 504 · Very Long-Term 756).
 */
export const GRID_CACHE_WINDOWS: number[] = [63, 252, 504, 756];

/** Read a cached per-stock grid for a (model, window), or null on miss. */
export async function readPerStockGridCache(
  model: ModelPresetName,
  window: number,
): Promise<PerStockResult | null> {
  const row = await db.perStockGridSnapshot.findUnique({
    where: { model_regressionWindow: { model, regressionWindow: window } },
    select: { resultJson: true },
  });
  if (!row) return null;
  return row.resultJson as unknown as PerStockResult;
}

/** Upsert a cached per-stock grid for a (model, window). */
export async function writePerStockGridCache(
  model: ModelPresetName,
  window: number,
  result: PerStockResult,
): Promise<void> {
  const json = result as unknown as Prisma.InputJsonValue;
  const asOfDate = new Date(`${result.asOfDate}T00:00:00.000Z`);
  await db.perStockGridSnapshot.upsert({
    where: { model_regressionWindow: { model, regressionWindow: window } },
    update: { resultJson: json, asOfDate, computedAt: new Date() },
    create: { model, regressionWindow: window, asOfDate, resultJson: json },
  });
}

export interface GridPrecomputeEntry {
  model: ModelPresetName;
  window: number;
  status: "ok" | "empty" | "error";
  rows?: number;
  asOfDate?: string;
  elapsedMs: number;
  error?: string;
}

/**
 * Precompute and persist every (model, window) grid combination. Sequential
 * by design — each combo already saturates a CPU core inside
 * runPerStockFactors, so parallelism would not help and would spike memory.
 */
export async function precomputeAllPerStockGrids(): Promise<{
  entries: GridPrecomputeEntry[];
  totalMs: number;
}> {
  const startedAt = Date.now();
  const entries: GridPrecomputeEntry[] = [];

  for (const model of GRID_CACHE_MODELS) {
    for (const window of GRID_CACHE_WINDOWS) {
      const t0 = Date.now();
      try {
        const result = await runPerStockFactors({ model, window });
        if (!result) {
          entries.push({ model, window, status: "empty", elapsedMs: Date.now() - t0 });
          continue;
        }
        await writePerStockGridCache(model, window, result);
        entries.push({
          model,
          window,
          status: "ok",
          rows: result.rows.length,
          asOfDate: result.asOfDate,
          elapsedMs: Date.now() - t0,
        });
      } catch (e) {
        entries.push({
          model,
          window,
          status: "error",
          elapsedMs: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { entries, totalMs: Date.now() - startedAt };
}
