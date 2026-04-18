import {
  annualizedRealizedVolatility,
  annualizedReturnFromDailyWindow,
} from "./volatility";

const ZERO_VOLATILITY_EPS = 1e-12;

/**
 * Sharpe = (R_ann - r_f) / sigma_ann
 * - R_ann = mean(daily) * 252
 * - sigma_ann = stddev(daily) * sqrt(252)
 * r_f: annualized risk-free rate (decimal, e.g. 0.04 for 4%).
 * If annualized vol is (near) zero, return null to avoid division by zero.
 */
export function sharpeRatio(
  dailyReturns: number[],
  riskFreeRateAnnual: number
): number | null {
  if (dailyReturns.length < 2) return null;
  const sigmaAnn = annualizedRealizedVolatility(dailyReturns);
  if (sigmaAnn == null) return null;
  if (sigmaAnn <= ZERO_VOLATILITY_EPS) return null;
  const rAnn = annualizedReturnFromDailyWindow(dailyReturns);
  return (rAnn - riskFreeRateAnnual) / sigmaAnn;
}
