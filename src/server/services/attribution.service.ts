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
import {
  computeDailyAttribution,
  computeStaticBetaDailyAttribution,
} from "@/lib/factors/attribution/daily";
import { computeCumulativeAttribution } from "@/lib/factors/attribution/cumulative";
import { computePeriodAttribution } from "@/lib/factors/attribution/period";
import {
  computeDailyLogAttribution,
  computeStaticBetaDailyLogAttribution,
} from "@/lib/factors/attribution/daily-log";
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

  // Rolling daily — evolving per-day betas. Powers the cumulative time-series
  // chart (AttributionClient / TimeSeriesPanel) which legitimately shows betas
  // drifting over time.
  const rollingDaily = computeDailyAttribution(
    rollingFits,
    factors,
    factorMap,
    portTotalMap,
    rfMap,
  );

  if (!rollingDaily.length) return null;

  const cumulative = computeCumulativeAttribution(rollingDaily);

  // Static-beta daily — the horizon end-fit loadings applied across the FULL
  // aligned history (not gated by the rolling burn-in). This is the series the
  // period panels slice, so trailing periods (1D…1Y) resolve at any horizon
  // even when the window consumes most of the history. Returned as `daily` so
  // the variance slicer (pickPeriodRiskSummary) and the return period buckets
  // share one contribution series.
  const daily = computeStaticBetaDailyAttribution(
    dates,
    engineResult.endFit.betas,
    factors,
    factorMap,
    portTotalMap,
    rfMap,
  );
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

    // Rolling log daily → cumulative log chart (evolving betas).
    const rollingDailyLog = computeDailyLogAttribution(
      engineResult.rollingFitsLog,
      factors,
      factorLogMap,
      portExcessLogMap,
      rfLogMap,
    );
    if (rollingDailyLog.length && engineResult.endFitLog) {
      cumulativeLog = computeCumulativeLogAttribution(rollingDailyLog);
      // Static-beta log daily over the full history → shipped dailyLog +
      // period buckets (mirrors the simple path).
      dailyLog = computeStaticBetaDailyLogAttribution(
        dates,
        engineResult.endFitLog.betas,
        factors,
        factorLogMap,
        portExcessLogMap,
        rfLogMap,
      );
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
