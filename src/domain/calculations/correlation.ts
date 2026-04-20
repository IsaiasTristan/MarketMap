/**
 * Correlation matrix computation from daily return series.
 */
import { pearsonCorr } from "./beta";

/** Compute a full pairwise correlation matrix from n return series of equal length. */
export function correlationMatrix(returnSeries: number[][]): number[][] {
  const n = returnSeries.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else if (j > i) {
        const corr = pearsonCorr(returnSeries[i], returnSeries[j]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
  }
  return matrix;
}
