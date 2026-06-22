/**
 * Rolling factor-beta series — the time-series of per-day factor betas that
 * powers the Attribution tab's "Rolling Factor Betas" chart.
 *
 * Pure builder (no DB / I/O): maps an engine result's rolling OLS fits into the
 * `{ dates, series, alphas, rSquareds }` shape the chart consumes. Persisted +
 * served by `factor-rolling-cache.service.ts`.
 */
import type { FactorEngineResult } from "@/types/factors";

export interface RollingBetaSeries {
  dates: string[];
  series: Record<string, number[]>;
  alphas: number[];
  rSquareds: number[];
  /** Most recent date in the rolling series. */
  asOfDate: string | null;
}

/**
 * Build the rolling-beta series from an engine result. One point per non-failed
 * rolling fit; betas are mapped back onto factor codes in model order.
 */
export function buildRollingBetaSeries(engineResult: FactorEngineResult): RollingBetaSeries {
  const factorCodes = engineResult.factors;
  const dates: string[] = [];
  const series: Record<string, number[]> = {};
  const alphas: number[] = [];
  const rSquareds: number[] = [];

  for (const code of factorCodes) series[code] = [];

  for (const point of engineResult.rollingFits) {
    if (point.fit.failed) continue;
    dates.push(point.date);
    alphas.push(point.fit.alpha);
    rSquareds.push(point.fit.rSquared);
    for (let i = 0; i < factorCodes.length; i++) {
      series[factorCodes[i]!]!.push(point.fit.betas[i] ?? 0);
    }
  }

  return { dates, series, alphas, rSquareds, asOfDate: dates[dates.length - 1] ?? null };
}
