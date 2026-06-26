/**
 * factor-attribution-cache.service — read/write/precompute the Factors-tab
 * attribution response (FactorAttributionSnapshot).
 *
 * The attribution GET route runs the full factor engine + attribution math on
 * every request. The daily job + market-hours runner precompute the response
 * per (portfolioId, model, window) and store the JSON blob here; the route
 * reads the cached row and only falls back to live compute on a miss (then
 * writes through).
 *
 * Cache key: (portfolioId, model, regressionWindow).
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import { computeFactorAttribution } from "./attribution.service";
import type {
  AttributionResult,
  FactorEngineResult,
  ModelPresetName,
} from "@/types/factors";

/** Read a cached attribution response, or null on miss. */
export async function readFactorAttributionCache(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
): Promise<AttributionResult | null> {
  const row = await db.factorAttributionSnapshot.findUnique({
    where: {
      portfolioId_model_regressionWindow: {
        portfolioId,
        model,
        regressionWindow: win,
      },
    },
    select: { payloadJson: true },
  });
  if (!row) return null;
  return row.payloadJson as unknown as AttributionResult;
}

/** Upsert a cached attribution response. */
export async function writeFactorAttributionCache(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
  result: AttributionResult,
): Promise<void> {
  const json = result as unknown as Prisma.InputJsonValue;
  const lastDate = result.daily[result.daily.length - 1]?.date;
  const asOfDate = lastDate
    ? new Date(`${lastDate}T00:00:00.000Z`)
    : new Date();
  await db.factorAttributionSnapshot.upsert({
    where: {
      portfolioId_model_regressionWindow: {
        portfolioId,
        model,
        regressionWindow: win,
      },
    },
    update: { payloadJson: json, asOfDate, computedAt: new Date() },
    create: {
      portfolioId,
      model,
      regressionWindow: win,
      asOfDate,
      payloadJson: json,
    },
  });
}

/** Compute + persist the attribution response (null on insufficient data). */
export async function computeAndCacheFactorAttribution(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
  precomputedEngine?: FactorEngineResult | null,
): Promise<AttributionResult | null> {
  const result = await computeFactorAttribution(
    portfolioId,
    model,
    win,
    precomputedEngine,
  );
  if (result) await writeFactorAttributionCache(portfolioId, model, win, result);
  return result;
}
