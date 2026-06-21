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
 * Rolling-OLS post-burn-in residual stream for a stock or portfolio.
 *
 * For each rolling-fit window (W observations ending at date t), takes the
 * fit and computes ε_t = y_t − ŷ_t where ŷ_t = α̂ + Σ_f β̂_f · x_{t,f}. The
 * `firstValidIdx` returned is the index into the (y, X) input where the
 * first non-failed rolling fit lands — useful when callers need to align
 * multiple stocks' residual streams to a common start date.
 *
 * Failed fits (insufficient DOF, singular pivot) drop the corresponding
 * observation rather than emitting NaN, so downstream code can sum / mean
 * without filtering.
 */
export function rollingResidualStream(
  dates: string[],
  y: number[],
  X: number[][],
  window: number,
  ewHalfLife?: number | null,
): {
  dates: string[];
  residuals: number[];
  /** Index into the input (y, X) of the first emitted residual. */
  firstValidIdx: number | null;
} {
  const fits = rollingMultivariateOls(dates, y, X, window, ewHalfLife);
  const k = X[0]?.length ?? 0;
  const out: { dates: string[]; residuals: number[]; firstValidIdx: number | null } = {
    dates: [],
    residuals: [],
    firstValidIdx: null,
  };
  // Each rolling-fit point r corresponds to input index t = (effective W − 1) + r.
  const minObs = window; // rolling already enforces minObs internally
  const startT = minObs - 1;
  for (let r = 0; r < fits.length; r++) {
    const t = startT + r;
    const fit = fits[r]!.fit;
    if (fit.failed) continue;
    const xt = X[t];
    const yt = y[t];
    if (!xt || yt == null) continue;
    let pred = fit.alpha;
    for (let fi = 0; fi < k; fi++) pred += (fit.betas[fi] ?? 0) * (xt[fi] ?? 0);
    const eps = yt - pred;
    out.dates.push(fits[r]!.date);
    out.residuals.push(eps);
    if (out.firstValidIdx === null) out.firstValidIdx = t;
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
