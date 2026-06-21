/**
 * Newey-West (1994) HAC standard error for the mean of a stationary,
 * possibly autocorrelated series. Used by the portfolio residual service to
 * compute T-stat and 95 % CI on the constructed series ε_p,t = Σ_i w_i · ε_i,t
 * — autocorrelation is non-trivial because rolling-OLS residuals share
 * overlapping windows.
 *
 * Bandwidth rule: L = max(1, min(n-1, floor(4 · (n/100)^(2/9)))) — the
 * Newey-West (1994) plug-in rule of thumb. Citing it correctly matters
 * because it's commonly mislabelled as "Andrews" (Andrews 1991 is a
 * data-driven AR(1)-based bandwidth in the same family but not this
 * formula).
 *
 * Kernel: Bartlett (linear taper). `S = γ_0 + 2 · Σ_{j=1..L} (1 − j/(L+1)) · γ_j`
 * where `γ_j = (1/n) · Σ_{t=j+1..n} (e_t − ē)(e_{t−j} − ē)`. This is the
 * long-run variance of the demeaned series. The HAC SE on the mean is
 * `√(S/n)`.
 */

export interface NeweyWestResult {
  /** Mean of the series. */
  mean: number;
  /** Newey-West (1994) HAC standard error of the MEAN. */
  hacSe: number;
  /** Bandwidth (lag truncation L) actually used. */
  bandwidth: number;
  /** Sample size. */
  n: number;
}

/**
 * Bandwidth from the Newey-West (1994) plug-in rule. Floored at 1 so the
 * estimator never silently degrades to OLS SE; capped at n−1.
 */
export function neweyWestBandwidth(n: number): number {
  if (!Number.isFinite(n) || n < 2) return 1;
  const raw = Math.floor(4 * Math.pow(n / 100, 2 / 9));
  return Math.max(1, Math.min(n - 1, raw));
}

/**
 * HAC SE on the mean of `series` using a Bartlett-kernel Newey-West
 * estimator with bandwidth from `neweyWestBandwidth(n)`. Returns
 * `{ mean, hacSe, bandwidth, n }`. Throws if the series is empty.
 */
export function neweyWestMeanSe(series: number[]): NeweyWestResult {
  const n = series.length;
  if (n === 0) {
    throw new Error("neweyWestMeanSe: empty series");
  }
  if (n === 1) {
    return { mean: series[0]!, hacSe: 0, bandwidth: 0, n: 1 };
  }
  const mean = series.reduce((s, v) => s + v, 0) / n;
  const dev = series.map((v) => v - mean);
  const L = neweyWestBandwidth(n);

  // γ_0 (population autocovariance, dividing by n — matches the standard
  // Newey-West specification; some texts use n − k for finite-sample bias
  // correction, but n is consistent with the Bartlett-kernel convention).
  let s = 0;
  for (let i = 0; i < n; i++) s += dev[i]! * dev[i]!;
  let runningS = s / n;

  for (let j = 1; j <= L; j++) {
    let gammaJ = 0;
    for (let t = j; t < n; t++) gammaJ += dev[t]! * dev[t - j]!;
    gammaJ /= n;
    const w = 1 - j / (L + 1);
    runningS += 2 * w * gammaJ;
  }

  // Negative long-run variance can occur with strong negative
  // autocorrelation past the truncation lag — clip to 0 rather than
  // sqrt(NaN). The HAC SE is then 0, which T downstream surfaces as a
  // failed estimate (caller decides whether to fall back).
  const longRunVar = Math.max(runningS, 0);
  const hacSe = Math.sqrt(longRunVar / n);
  return { mean, hacSe, bandwidth: L, n };
}
