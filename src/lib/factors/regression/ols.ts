/**
 * Multivariate OLS regression.
 *
 * y = alpha + X β + ε
 *
 * The intercept column is added internally; callers pass only the factor
 * columns. Betas are returned in factor order (alpha is separate).
 *
 * Numerical strategy: normal equations (X'WX)⁻¹ X'Wy with Gauss-Jordan
 * inversion; Tikhonov ridge fallback if near-singular.
 */
import type { RegressionFit } from "@/types/factors";
import { invertWithRidge, matMul, matVec, transpose, zeros } from "./matrix";

/**
 * Run weighted multivariate OLS.
 *
 * @param y       Dependent variable (n observations).
 * @param X       Factor matrix — rows = observations, cols = factors (n × k).
 *                Do NOT include a constant column; it is added here.
 * @param weights Optional weight vector (n). Defaults to uniform 1/n.
 *                Weights do not need to sum to 1 — they are normalized internally.
 * @returns       RegressionFit, or a fallback fit with zero betas if data is
 *                insufficient (n < k + 2).
 */
export function multivariateOls(
  y: number[],
  X: number[][],
  weights?: number[],
): RegressionFit {
  const n = y.length;
  const k = X[0]?.length ?? 0;

  // Minimum degrees of freedom required
  if (n < k + 2 || k < 1) {
    return fallbackFit(k, n);
  }

  // Build weight vector (normalized)
  const w = buildWeights(n, weights);

  // Augment X with intercept column: X_aug is n × (k+1)
  const X_aug: number[][] = X.map((row, i) => [1, ...row]);
  const K = k + 1; // columns including intercept

  // Weighted X'WX (K × K) and X'Wy (K)
  const XtWX = zeros(K, K);
  const XtWy = new Array<number>(K).fill(0);

  for (let i = 0; i < n; i++) {
    const wi = w[i]!;
    const xi = X_aug[i]!;
    const yi = y[i]!;
    for (let a = 0; a < K; a++) {
      XtWy[a]! += wi * xi[a]! * yi;
      for (let b = 0; b < K; b++) {
        XtWX[a]![b]! += wi * xi[a]! * xi[b]!;
      }
    }
  }

  // Invert X'WX (with ridge fallback)
  const { inv: XtWXinv, regularized, failed } = invertWithRidge(XtWX);

  // β_hat = (X'WX)⁻¹ X'Wy
  const betaAll = matVec(XtWXinv, XtWy);
  const alpha = betaAll[0]!;
  const betas = betaAll.slice(1);

  // Residuals
  const residuals = y.map((yi, i) => {
    const xi = X_aug[i]!;
    const yhat = xi.reduce((s, xij, j) => s + xij * betaAll[j]!, 0);
    return yi - yhat;
  });

  // R² and adjusted R²
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (y[i]! - yMean) ** 2;
    ssRes += residuals[i]! ** 2;
  }
  const rSquared = ssTot > 1e-16 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const adjRSquared =
    n > K ? 1 - (1 - rSquared) * ((n - 1) / (n - K)) : 0;

  // Variance of residuals: σ² = Σ w_i e_i² / (n - K) using effective n
  const dof = Math.max(1, n - K);
  let sigSq = 0;
  for (let i = 0; i < n; i++) {
    sigSq += w[i]! * residuals[i]! ** 2;
  }
  sigSq /= dof;

  // Covariance of β: σ² × (X'WX)⁻¹
  // Standard errors and t-stats for each coefficient
  const stdErrors: number[] = [];
  const tStats: number[] = [];
  for (let j = 0; j < k; j++) {
    const se = Math.sqrt(Math.max(0, sigSq * (XtWXinv[j + 1]?.[j + 1] ?? 0)));
    stdErrors.push(se);
    tStats.push(se > 0 ? betas[j]! / se : 0);
  }
  const alphaStdError = Math.sqrt(Math.max(0, sigSq * (XtWXinv[0]?.[0] ?? 0)));
  const alphaTStat = alphaStdError > 0 ? alpha / alphaStdError : 0;

  return {
    betas,
    alpha,
    residuals,
    rSquared,
    adjRSquared,
    tStats,
    stdErrors,
    alphaTStat,
    alphaStdError,
    n,
    k,
    regularized,
    failed,
  };
}

/** Build a normalized weight vector. */
function buildWeights(n: number, weights?: number[]): number[] {
  if (!weights || weights.length !== n) {
    return new Array<number>(n).fill(1 / n);
  }
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0) return new Array<number>(n).fill(1 / n);
  return weights.map((w) => Math.max(0, w) / sum);
}

/**
 * Return a zeroed-out fallback fit when insufficient data (n < k+2 or k < 1).
 * `failed: true` is set so callers can detect this case and exclude it from
 * cumulative sums (no silent zeroing of valid days, per Phase 3 lock-in).
 */
function fallbackFit(k: number, n: number): RegressionFit {
  return {
    betas: new Array<number>(k).fill(0),
    alpha: 0,
    residuals: new Array<number>(n).fill(0),
    rSquared: 0,
    adjRSquared: 0,
    tStats: new Array<number>(k).fill(0),
    stdErrors: new Array<number>(k).fill(0),
    alphaTStat: 0,
    alphaStdError: 0,
    n,
    k,
    regularized: false,
    failed: true,
  };
}
