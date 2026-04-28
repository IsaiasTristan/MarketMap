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
import { computeDailyLogAttribution } from "@/lib/factors/attribution/daily-log";
import { computeCumulativeLogAttribution } from "@/lib/factors/attribution/cumulative-log";
import { computePeriodLogAttribution } from "@/lib/factors/attribution/period-log";
import type {
  AttributionDayPointLog,
  AttributionResult,
  CumulativeAttributionPointLog,
  PeriodAttributionSummaryLog,
  ModelPresetName,
} from "@/types/factors";

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

  // ---------------------------------------------------------------------
  // Path B (log) — only emitted when the engine produced a parallel log
  // pipeline and a separate set of log rolling fits.
  // ---------------------------------------------------------------------
  let dailyLog: AttributionDayPointLog[] | null = null;
  let cumulativeLog: CumulativeAttributionPointLog[] | null = null;
  let periodsLog: PeriodAttributionSummaryLog[] | null = null;

  if (
    engineResult.portExcessLogReturns &&
    engineResult.factorLogReturns &&
    engineResult.rfLogReturns &&
    engineResult.rollingFitsLog
  ) {
    const portExcessLogMap = new Map(
      dates.map((d, i) => [d, engineResult.portExcessLogReturns![i]!]),
    );
    const rfLogMap = new Map(
      dates.map((d, i) => [d, engineResult.rfLogReturns![i]!]),
    );
    const factorLogMap = new Map(
      dates.map((d, i) => {
        const day: Record<string, number> = {};
        for (const code of factors) {
          day[code] = engineResult.factorLogReturns![code]?.[i] ?? 0;
        }
        return [d, day];
      }),
    );

    dailyLog = computeDailyLogAttribution(
      engineResult.rollingFitsLog,
      factors,
      factorLogMap,
      portExcessLogMap,
      rfLogMap,
    );
    if (dailyLog.length) {
      cumulativeLog = computeCumulativeLogAttribution(dailyLog);
      periodsLog = computePeriodLogAttribution(dailyLog, factors);
    } else {
      dailyLog = null;
    }
  }

  // Provenance badge
  const pipelineStatus = await db.factorPipelineStatus.findFirst();
  const provenanceBadge = pipelineStatus?.lastFrenchDate
    ? {
        frenchThrough: pipelineStatus.lastFrenchDate.toISOString().slice(0, 10),
        proxyFrom: pipelineStatus.lastFrenchDate.toISOString().slice(0, 10),
        proxyTo: new Date().toISOString().slice(0, 10),
      }
    : null;

  return {
    daily,
    cumulative,
    periods,
    dailyLog,
    cumulativeLog,
    periodsLog,
    provenanceBadge,
  };
}

/**
 * Trade statistics from closed positions.
 *
 * The simplified position model (2026-04-26) tracks only the user's current
 * portfolio (ticker + shares + L/S) — there are no entry/exit prices or
 * close events to compute realised-trade win rates against. Returns an
 * empty stats object so consumers don't crash.
 */
export async function computeTradeStatistics(_portfolioId: string) {
  return computeTradeStats([]);
}
