import { mean, standardDeviationSample } from "./math";

const TRADING_DAYS = 252;

/**
 * Annualized **realized** volatility from a window of **daily** simple returns.
 * annualized = stdDev(daily) * sqrt(252)
 */
export function annualizedRealizedVolatility(
  dailyReturns: number[]
): number | null {
  if (dailyReturns.length < 2) return null;
  return standardDeviationSample(dailyReturns) * Math.sqrt(TRADING_DAYS);
}

/**
 * Annualized return from a window of daily simple returns, using product rule:
 * mean(daily) * 252. Used alongside annualized vol for Sharpe, per methodology.
 */
export function annualizedReturnFromDailyWindow(dailyReturns: number[]): number {
  return mean(dailyReturns) * TRADING_DAYS;
}

export { TRADING_DAYS };
