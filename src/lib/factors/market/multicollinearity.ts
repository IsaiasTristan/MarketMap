/**
 * Multicollinearity diagnostics for the factor matrix.
 *
 * VIF (Variance Inflation Factor) per factor:
 *   VIF_j = 1 / (1 - R²_j)
 * where R²_j is the R² of regressing factor j on all other factors. A VIF
 * above ~5 is conventionally considered "high collinearity"; above 10 is
 * commonly cited as severe (β estimates become unstable).
 *
 * Condition number of the factor correlation matrix:
 *   κ = sqrt(λ_max / λ_min)
 * where λ are the eigenvalues. We approximate eigenvalues via the power
 * method on the correlation matrix and on its inverse (smallest eigenvalue
 * = 1 / largest eigenvalue of inverse). Conventional flag: κ > 30 is
 * problematic; > 100 is severe.
 *
 * All inputs assumed numerically clean (finite, no NaN). Functions degrade
 * gracefully (return 0/Inf/NaN) when matrices are singular.
 */
import { invert } from "../regression/matrix";

const ABSURD_VIF = 1e6;

/**
 * Compute VIF for each column of a (n × k) matrix using sample correlation.
 * Uses the formula VIF_j = (R⁻¹)_jj where R is the k×k correlation matrix
 * (closed-form, no need to run k auxiliary regressions).
 *
 * Returns an array of length k. Entries are clamped to a large finite value
 * if the correlation matrix is singular for that column.
 */
export function computeVIF(corrMatrix: number[][]): number[] {
  const k = corrMatrix.length;
  if (k === 0) return [];
  const inv = invert(corrMatrix);
  if (!inv) return new Array<number>(k).fill(ABSURD_VIF);
  const out: number[] = new Array(k).fill(0);
  for (let i = 0; i < k; i++) {
    const v = inv[i]?.[i] ?? ABSURD_VIF;
    out[i] = Number.isFinite(v) && v > 0 ? v : ABSURD_VIF;
  }
  return out;
}

/**
 * Power-iteration largest eigenvalue of a symmetric PSD matrix.
 * Returns the dominant eigenvalue.
 */
function powerIterMaxEig(A: number[][], iters = 80): number {
  const n = A.length;
  if (n === 0) return 0;
  const v = new Array<number>(n).fill(1 / Math.sqrt(n));
  let lambda = 0;
  for (let iter = 0; iter < iters; iter++) {
    const Av = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const Ai = A[i]!;
      for (let j = 0; j < n; j++) s += Ai[j]! * (v[j] ?? 0);
      Av[i] = s;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += Av[i]! * Av[i]!;
    norm = Math.sqrt(norm);
    if (norm < 1e-18) return 0;
    for (let i = 0; i < n; i++) v[i] = Av[i]! / norm;
    lambda = norm;
  }
  return lambda;
}

/**
 * Condition number κ = √(λ_max / λ_min) of a symmetric PSD matrix
 * (typically the factor correlation matrix). Uses power iteration on M and
 * on M⁻¹ to estimate the smallest eigenvalue. Returns Infinity if the
 * matrix is singular.
 */
export function conditionNumber(corrMatrix: number[][]): number {
  const k = corrMatrix.length;
  if (k === 0) return 0;
  const lambdaMax = powerIterMaxEig(corrMatrix);
  if (lambdaMax <= 0) return Number.POSITIVE_INFINITY;
  const inv = invert(corrMatrix);
  if (!inv) return Number.POSITIVE_INFINITY;
  const invMaxEig = powerIterMaxEig(inv);
  if (invMaxEig <= 0) return Number.POSITIVE_INFINITY;
  const lambdaMin = 1 / invMaxEig;
  if (lambdaMin <= 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(lambdaMax / lambdaMin);
}

export interface MulticollinearityReport {
  /** Per-factor VIF, in same order as the input correlation matrix rows. */
  vif: number[];
  /** κ = √(λmax / λmin) of the correlation matrix. */
  conditionNumber: number;
  /** True if any |ρ| ≥ pairwiseFlag (default 0.7) off-diagonal. */
  hasHighPairwise: boolean;
  /** Pairs with |ρ| ≥ pairwiseFlag, sorted by descending |ρ|. */
  highPairs: { i: number; j: number; rho: number }[];
}

export function multicollinearityReport(
  corrMatrix: number[][],
  pairwiseFlag = 0.7,
): MulticollinearityReport {
  const k = corrMatrix.length;
  const vif = computeVIF(corrMatrix);
  const cond = conditionNumber(corrMatrix);
  const highPairs: { i: number; j: number; rho: number }[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const r = corrMatrix[i]?.[j] ?? 0;
      if (Math.abs(r) >= pairwiseFlag) highPairs.push({ i, j, rho: r });
    }
  }
  highPairs.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  return {
    vif,
    conditionNumber: cond,
    hasHighPairwise: highPairs.length > 0,
    highPairs,
  };
}
