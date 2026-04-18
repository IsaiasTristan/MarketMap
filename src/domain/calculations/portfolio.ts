import { mean, standardDeviationSample } from "./math";
import { TRADING_DAYS } from "./volatility";

type DailyReturnRow = { weights: number[]; dailyReturns: number[] };

/**
 * Rebalancing assumed implicit each day: portfolio daily return
 *   sum_i w_i * r_i(t)
 * where weights sum to 1.
 */
export function portfolioDailyReturn(row: DailyReturnRow): number | null {
  const n = row.weights.length;
  if (n === 0 || n !== row.dailyReturns.length) return null;
  return row.weights.reduce((s, w, i) => s + w * (row.dailyReturns[i] ?? 0), 0);
}

export function sumWeights(weights: number[]): number {
  return weights.reduce((a, b) => a + b, 0);
}

/**
 * Each entry is one trading day; `componentReturns[t][i]` is holding `i`'s
 * daily return on that day. Weights should sum to 1 (validated upstream).
 */
export function portfolioDailyReturnSeries(
  weights: number[],
  componentReturnsByDay: number[][]
): number[] {
  if (componentReturnsByDay.length === 0) return [];
  const out: number[] = [];
  for (const dayReturns of componentReturnsByDay) {
    if (weights.length !== dayReturns.length) {
      out.push(0);
      continue;
    }
    out.push(weights.reduce((a, w, i) => a + w * (dayReturns[i] ?? 0), 0));
  }
  return out;
}

export function annualizedReturnFromPortDaily(daily: number[]): number {
  return mean(daily) * TRADING_DAYS;
}

export function annualizedPortVol(daily: number[]): number | null {
  if (daily.length < 2) return null;
  return standardDeviationSample(daily) * Math.sqrt(TRADING_DAYS);
}

/**
 * Same Sharpe structure as single-name: (R_ann - r_f) / sigma_ann
 */
export function portfolioSharpe(
  portfolioDaily: number[],
  riskFreeRateAnnual: number
): number | null {
  if (portfolioDaily.length < 2) return null;
  const sigma = annualizedPortVol(portfolioDaily);
  if (sigma == null || sigma <= 1e-12) return null;
  return (annualizedReturnFromPortDaily(portfolioDaily) - riskFreeRateAnnual) / sigma;
}
