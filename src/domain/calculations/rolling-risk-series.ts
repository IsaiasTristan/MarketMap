/**
 * Rolling vol / Sharpe series for position-level sparklines.
 * All inputs are daily simple returns; vol is annualized (× √252).
 */

import { annualizedRealizedVolatility } from "./volatility";
import { rollingSharpeRatio } from "./distribution";

const TRADING_DAYS = 252;

/** Last `lookback` valid rolling-window values, decimated to `maxPoints`. */
export function decimateSeries(values: number[], maxPoints = 60): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length <= maxPoints) return finite;
  const step = finite.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(finite[Math.floor(i * step)]!);
  }
  return out;
}

/**
 * Rolling annualized vol: each point = σ_ann of the preceding `window` daily returns.
 * Points before `window` observations are NaN.
 */
export function rollingAnnualizedVolatilitySeries(
  dailyReturns: number[],
  window: number,
): number[] {
  const out: number[] = new Array(dailyReturns.length).fill(Number.NaN);
  for (let i = window; i <= dailyReturns.length; i++) {
    out[i - 1] =
      annualizedRealizedVolatility(dailyReturns.slice(i - window, i)) ?? Number.NaN;
  }
  return out;
}

/**
 * Trailing sparkline of rolling vol over the last `lookback` trading days.
 */
export function rollingVolSparkline(
  dailyReturns: number[],
  window: number,
  lookback = TRADING_DAYS,
  maxPoints = 60,
): number[] {
  const series = rollingAnnualizedVolatilitySeries(dailyReturns, window);
  const tail = series.slice(-lookback).filter((v) => Number.isFinite(v));
  return decimateSeries(tail, maxPoints);
}

/**
 * Trailing sparkline of rolling Sharpe over the last `lookback` trading days.
 */
export function rollingSharpeSparkline(
  dailyReturns: number[],
  window: number,
  annualRf: number,
  lookback = TRADING_DAYS,
  maxPoints = 60,
): number[] {
  const series = rollingSharpeRatio(dailyReturns, annualRf, window);
  const tail = series.slice(-lookback).filter((v) => Number.isFinite(v));
  return decimateSeries(tail, maxPoints);
}
