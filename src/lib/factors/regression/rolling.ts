/**
 * Rolling multivariate OLS regression.
 *
 * For each date t ≥ window, fits the model using the window of observations
 * ending at t (inclusive). Returns one RollingFitPoint per date.
 */
import type { RollingFitPoint } from "@/types/factors";
import { multivariateOls } from "./ols";
import { exponentialWeights } from "./weights";
import { minObservations } from "../definitions/model-presets";

/**
 * Compute rolling regression fits.
 *
 * @param dates    Aligned date strings (length = n).
 * @param y        Dependent variable (length = n).
 * @param X        Factor matrix rows × factors (length = n, each row has k values).
 * @param window   Lookback in observations.
 * @param ewHalfLife Optional EW half-life. null = uniform.
 * @returns        Array of RollingFitPoint, one per date starting at index (window - 1).
 */
export function rollingMultivariateOls(
  dates: string[],
  y: number[],
  X: number[][],
  window: number,
  ewHalfLife?: number | null,
): RollingFitPoint[] {
  const n = dates.length;
  const k = X[0]?.length ?? 0;
  const minObs = minObservations(k);
  const effectiveWindow = Math.max(window, minObs);
  const out: RollingFitPoint[] = [];

  for (let end = effectiveWindow - 1; end < n; end++) {
    const start = end - effectiveWindow + 1;
    const ySlice = y.slice(start, end + 1);
    const xSlice = X.slice(start, end + 1);
    const weights = exponentialWeights(effectiveWindow, ewHalfLife);
    const fit = multivariateOls(ySlice, xSlice, weights);
    out.push({ date: dates[end]!, fit });
  }

  return out;
}

/**
 * Extract a single factor's rolling beta series from rolling fit output.
 */
export function extractRollingBeta(
  rollingFits: RollingFitPoint[],
  factorIndex: number,
): { dates: string[]; betas: number[]; tStats: number[] } {
  const dates: string[] = [];
  const betas: number[] = [];
  const tStats: number[] = [];
  for (const { date, fit } of rollingFits) {
    dates.push(date);
    betas.push(fit.betas[factorIndex] ?? 0);
    tStats.push(fit.tStats[factorIndex] ?? 0);
  }
  return { dates, betas, tStats };
}
