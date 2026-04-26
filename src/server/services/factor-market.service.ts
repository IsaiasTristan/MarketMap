/**
 * factor-market.service — market-context factor performance and correlations.
 *
 * Returns per-factor performance stats and a factor × factor correlation
 * matrix for the requested factor set. The factor set defaults to the
 * MACRO14 institutional preset; pass `factorCodes` (or `model`) for a
 * different scope (e.g. FF5 / FF3 from the UI).
 */
import { computeFactorMarketStats } from "@/lib/factors/market/factor-stats";
import { computeFactorCorrelationMatrix } from "@/lib/factors/market/correlations";
import { multicollinearityReport } from "@/lib/factors/market/multicollinearity";
import { getAllFactorReturnSeries } from "./factor-engine.service";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import type { FactorMarketContext, FactorCode, ModelPresetName } from "@/types/factors";

interface MarketContextOptions {
  factorCodes?: FactorCode[];
  model?: ModelPresetName;
  corrWindow?: number;
}

export async function getFactorMarketContext(
  options: MarketContextOptions = {},
): Promise<FactorMarketContext> {
  const corrWindow = options.corrWindow ?? 252;
  const codes: FactorCode[] =
    options.factorCodes ??
    ((options.model
      ? resolveModel(options.model).factors
      : resolveModel("MACRO14").factors) as FactorCode[]);

  const { dates, byFactor, rfSeries } = await getAllFactorReturnSeries(Math.max(corrWindow, 252));

  const stats = computeFactorMarketStats(byFactor, rfSeries, codes);
  const correlationMatrix = computeFactorCorrelationMatrix(byFactor, codes, corrWindow);
  const asOfDate = dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10);

  const flagThreshold = 0.7;
  const mcReport = multicollinearityReport(correlationMatrix, flagThreshold);

  return {
    stats,
    correlationMatrix,
    correlationWindow: corrWindow,
    asOfDate,
    multicollinearity: {
      vif: mcReport.vif,
      conditionNumber: mcReport.conditionNumber,
      highPairs: mcReport.highPairs,
      flagThreshold,
    },
  };
}
