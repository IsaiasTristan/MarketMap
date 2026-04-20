/**
 * Factor covariance matrix estimation from historical factor return series.
 *
 * Supports uniform and exponential weighting. The covariance matrix is
 * annualized by multiplying by 252 (trading days per year).
 */

/** Compute a sample covariance matrix from factor return data.
 *
 * @param factorSeries  Array of factor return series; each is a number[] of
 *                      length n ordered oldest → newest. Ordering must match
 *                      the factor list.
 * @param weights       Optional exponential weights (length n). null = uniform.
 * @param annualize     Multiply by 252 (default: true).
 * @returns k × k annualized covariance matrix.
 */
export function factorCovarianceMatrix(
  factorSeries: number[][],
  weights?: number[] | null,
  annualize = true,
): number[][] {
  const k = factorSeries.length;
  const n = factorSeries[0]?.length ?? 0;

  if (k === 0 || n < 2) {
    return Array.from({ length: k }, () => new Array<number>(k).fill(0));
  }

  // Build weight vector
  const rawW = weights && weights.length === n ? weights : new Array<number>(n).fill(1);
  const wSum = rawW.reduce((s, w) => s + w, 0);
  const w = rawW.map((wi) => wi / wSum);

  // Weighted means
  const means = factorSeries.map((series) =>
    series.reduce((s, v, i) => s + w[i]! * v, 0),
  );

  // Weighted covariance: Cov(i,j) = Σ w_t (x_t - μ_i)(y_t - μ_j) / (1 - Σw²)
  // (Bessel-corrected equivalent for weighted samples)
  const wSqSum = w.reduce((s, wi) => s + wi ** 2, 0);
  const corrFactor = 1 - wSqSum; // weighted Bessel correction denominator

  const cov = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let t = 0; t < n; t++) {
        s += w[t]! * (factorSeries[a]![t]! - means[a]!) * (factorSeries[b]![t]! - means[b]!);
      }
      const val = corrFactor > 0 ? s / corrFactor : s;
      cov[a]![b] = val;
      cov[b]![a] = val;
    }
  }

  if (annualize) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) {
        cov[a]![b]! *= 252;
      }
    }
  }

  return cov;
}
