/**
 * Exponential weighting for WLS regressions.
 *
 * Older observations receive lower weight, giving more influence to recent data.
 * Weight for observation at index i (0 = oldest, n-1 = newest):
 *   w_i = λ^(n-1-i)   where λ = 0.5^(1/halfLife)
 *
 * Weights are NOT normalized here; `multivariateOls` normalizes them internally.
 */

/**
 * Build exponential weights for n observations, with the newest observation
 * receiving weight = 1 and older observations receiving exponentially lower weight.
 *
 * @param n        Number of observations.
 * @param halfLife Half-life in the same units as observations (trading days).
 *                 e.g. halfLife = 63 means 63 periods ago has weight = 0.5.
 *                 null / undefined = uniform (returns array of 1s).
 * @returns        Weight vector of length n (newest last, highest weight).
 */
export function exponentialWeights(n: number, halfLife?: number | null): number[] {
  if (!halfLife || halfLife <= 0) {
    return new Array<number>(n).fill(1);
  }
  const decay = Math.pow(0.5, 1 / halfLife);
  const weights = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // i = 0 is oldest, i = n-1 is newest
    weights[i] = Math.pow(decay, n - 1 - i);
  }
  return weights;
}
