/**
 * factor-market.service — market-context factor performance and correlations.
 */
import { computeFactorMarketStats } from "@/lib/factors/market/factor-stats";
import { computeFactorCorrelationMatrix } from "@/lib/factors/market/correlations";
import { getAllFactorReturnSeries } from "./factor-engine.service";
import { FACTOR_DISPLAY_ORDER } from "@/lib/factors/definitions/factor-codes";
import type { FactorMarketContext, FactorCode } from "@/types/factors";

export async function getFactorMarketContext(
  factorCodes?: FactorCode[],
  corrWindow = 252,
): Promise<FactorMarketContext> {
  const codes = factorCodes ?? FACTOR_DISPLAY_ORDER;
  const { dates, byFactor, rfSeries } = await getAllFactorReturnSeries(Math.max(corrWindow, 252));

  const stats = computeFactorMarketStats(byFactor, rfSeries, codes);
  const correlationMatrix = computeFactorCorrelationMatrix(byFactor, codes, corrWindow);
  const asOfDate = dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10);

  return {
    stats,
    correlationMatrix,
    correlationWindow: corrWindow,
    asOfDate,
  };
}
