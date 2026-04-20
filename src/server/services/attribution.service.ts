/**
 * attribution.service — factor return attribution and trade statistics.
 *
 * Attribution now delegates to the shared factor engine (joint multivariate OLS)
 * instead of the legacy univariate regression per factor.
 *
 * computeTradeStatistics is unchanged.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { computeTradeStats } from "@/domain/calculations/attribution";
import { runFactorEngine } from "./factor-engine.service";
import { computeDailyAttribution } from "@/lib/factors/attribution/daily";
import { computeCumulativeAttribution } from "@/lib/factors/attribution/cumulative";
import { computePeriodAttribution } from "@/lib/factors/attribution/period";
import type { AttributionResult, FactorCode, ModelPresetName } from "@/types/factors";

/**
 * Compute factor return attribution for a portfolio.
 * Returns null when there is insufficient data.
 *
 * @param portfolioId  Portfolio to analyse.
 * @param model        Factor model preset name (default: FF5).
 * @param window       Rolling regression window in trading days (default: 252).
 */
export async function computeFactorAttribution(
  portfolioId: string,
  model: ModelPresetName = "FF5",
  window = 252,
): Promise<AttributionResult | null> {
  const engineResult = await runFactorEngine({ portfolioId, model, window });
  if (!engineResult || !engineResult.rollingFits.length) return null;

  const { rollingFits, factorReturns, portTotalReturns, rfReturns, dates, factors } = engineResult;

  // Build maps for the daily attribution function
  const portTotalMap = new Map(dates.map((d, i) => [d, portTotalReturns[i]!]));
  const rfMap = new Map(dates.map((d, i) => [d, rfReturns[i]!]));
  const factorMap = new Map(
    dates.map((d, i) => {
      const day: Record<string, number> = {};
      for (const code of factors) {
        day[code] = factorReturns[code]?.[i] ?? 0;
      }
      return [d, day];
    }),
  );

  const daily = computeDailyAttribution(
    rollingFits,
    factors,
    factorMap,
    portTotalMap,
    rfMap,
  );

  if (!daily.length) return null;

  const cumulative = computeCumulativeAttribution(daily);
  const periods = computePeriodAttribution(daily, factors);

  // Provenance badge
  const pipelineStatus = await db.factorPipelineStatus.findFirst();
  const provenanceBadge = pipelineStatus?.lastFrenchDate
    ? {
        frenchThrough: pipelineStatus.lastFrenchDate.toISOString().slice(0, 10),
        proxyFrom: pipelineStatus.lastFrenchDate.toISOString().slice(0, 10),
        proxyTo: new Date().toISOString().slice(0, 10),
      }
    : null;

  return { daily, cumulative, periods, provenanceBadge };
}

/** Trade statistics from closed positions — unchanged. */
export async function computeTradeStatistics(portfolioId: string) {
  const closed = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: { not: null } },
    select: {
      entryDate: true,
      closedAt: true,
      entryPrice: true,
      exitPrice: true,
      shares: true,
    },
  });

  const trades = closed
    .filter((t) => t.closedAt && t.exitPrice != null)
    .map((t) => ({
      entryDate: t.entryDate.toISOString().slice(0, 10),
      exitDate: t.closedAt!.toISOString().slice(0, 10),
      entryPrice: Number(t.entryPrice),
      exitPrice: Number(t.exitPrice!),
      shares: Number(t.shares),
    }));

  return computeTradeStats(trades);
}
