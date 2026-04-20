/**
 * Factor scoring: winsorize, z-score within universe, composite scores.
 */

/** Winsorize at the 1st and 99th percentile. */
export function winsorize(values: number[], lo = 0.01, hi = 0.99): number[] {
  if (!values.length) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const loIdx = Math.floor(values.length * lo);
  const hiIdx = Math.ceil(values.length * hi) - 1;
  const loVal = sorted[loIdx] ?? sorted[0];
  const hiVal = sorted[hiIdx] ?? sorted[sorted.length - 1];
  return values.map((v) => Math.max(loVal, Math.min(hiVal, v)));
}

/** Z-score a vector within the universe. */
export function zScore(values: number[]): number[] {
  const n = values.length;
  if (n < 2) return values.map(() => 0);
  const m = values.reduce((s, v) => s + v, 0) / n;
  const s = Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (n - 1));
  if (s === 0) return values.map(() => 0);
  return values.map((v) => (v - m) / s);
}

/** Composite score: winsorize then z-score each metric, average z-scores. */
export function compositeScore(metricVectors: number[][]): number[] {
  if (!metricVectors.length) return [];
  const n = metricVectors[0].length;
  const zScored = metricVectors.map((vec) => {
    const winsorized = winsorize(vec);
    return zScore(winsorized);
  });
  return Array.from({ length: n }, (_, i) => {
    const vals = zScored.map((z) => z[i] ?? 0).filter(isFinite);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  });
}

/** Weighted portfolio exposure to a factor: Σ(wᵢ × zᵢ). */
export function portfolioExposure(weights: number[], zScores: number[]): number {
  const n = Math.min(weights.length, zScores.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (weights[i] ?? 0) * (zScores[i] ?? 0);
  }
  return sum;
}

/** Momentum 12-1: return from 252 to 21 trading days ago. */
export function momentum12m1(adjCloses: number[]): number | null {
  if (adjCloses.length < 252) return null;
  const t0 = adjCloses[adjCloses.length - 1 - 21];
  const t252 = adjCloses[adjCloses.length - 1 - 252];
  if (!t252 || !t0 || t252 === 0) return null;
  return t0 / t252 - 1;
}
