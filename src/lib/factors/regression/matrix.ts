/**
 * Compact matrix arithmetic for small (k ≤ ~10) matrices.
 * All matrices are row-major: M[row][col].
 */

export type Matrix = number[][];

/** Create n×m zero matrix. */
export function zeros(n: number, m: number): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

/** Transpose an n×m matrix → m×n. */
export function transpose(A: Matrix): Matrix {
  const n = A.length;
  const m = A[0]?.length ?? 0;
  const T = zeros(m, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      T[j]![i] = A[i]![j]!;
    }
  }
  return T;
}

/** Multiply A (n×p) by B (p×m) → n×m. */
export function matMul(A: Matrix, B: Matrix): Matrix {
  const n = A.length;
  const p = B.length;
  const m = B[0]?.length ?? 0;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < p; k++) {
      const aik = A[i]![k]!;
      if (aik === 0) continue;
      for (let j = 0; j < m; j++) {
        C[i]![j]! += aik * B[k]![j]!;
      }
    }
  }
  return C;
}

/** Multiply matrix A (n×m) by vector v (m) → vector (n). */
export function matVec(A: Matrix, v: number[]): number[] {
  return A.map((row) => row.reduce((s, a, j) => s + a * (v[j] ?? 0), 0));
}

/** Add scalar × identity to square matrix A (Tikhonov regularization). */
export function addRidge(A: Matrix, lambda: number): Matrix {
  const n = A.length;
  const B = A.map((row) => [...row]);
  for (let i = 0; i < n; i++) {
    B[i]![i]! += lambda;
  }
  return B;
}

/** Frobenius trace (sum of diagonal). */
export function trace(A: Matrix): number {
  return A.reduce((s, row, i) => s + (row[i] ?? 0), 0);
}

/**
 * Invert a square matrix using Gauss-Jordan elimination with partial pivoting.
 * Returns null if singular (det ≈ 0 after pivoting).
 * For production correctness on small (≤ 10×10) matrices this is sufficient.
 */
export function invert(A: Matrix): Matrix | null {
  const n = A.length;
  // Augmented [A | I]
  const aug: number[][] = A.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) r.push(j === i ? 1 : 0);
    return r;
  });

  for (let col = 0; col < n; col++) {
    // Partial pivot: find row with max |value| in this column
    let maxRow = col;
    let maxVal = Math.abs(aug[col]![col]!);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(aug[row]![col]!);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }
    if (maxVal < 1e-14) return null; // singular

    // Swap rows
    [aug[col], aug[maxRow]] = [aug[maxRow]!, aug[col]!];

    // Normalize pivot row
    const pivot = aug[col]![col]!;
    for (let j = 0; j < 2 * n; j++) aug[col]![j]! /= pivot;

    // Eliminate column in all other rows
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        aug[row]![j]! -= factor * aug[col]![j]!;
      }
    }
  }

  // Extract right half
  return aug.map((row) => row.slice(n));
}

/**
 * Invert A with Tikhonov ridge fallback.
 * If A is singular, adds λ = ridgeRatio × trace(A) / n to the diagonal.
 * Returns `failed: true` only when both the direct invert AND the ridge
 * invert fail (i.e. both pivots underflow). In that case the returned
 * `inv` is the identity (so callers can continue computing without
 * crashing) — the `failed` flag tells the caller the OLS coefficients
 * are meaningless and the day should be dropped from cumulative sums
 * (no silent degradation, per Phase 3 lock-in).
 */
export function invertWithRidge(
  A: Matrix,
  ridgeRatio = 1e-8,
): { inv: Matrix; regularized: boolean; failed: boolean } {
  const inv = invert(A);
  if (inv) return { inv, regularized: false, failed: false };

  const n = A.length;
  const lambda = ridgeRatio * trace(A) / n;
  const Areg = addRidge(A, lambda);
  const invReg = invert(Areg);
  if (!invReg) {
    const identity = zeros(n, n);
    for (let i = 0; i < n; i++) identity[i]![i] = 1;
    return { inv: identity, regularized: true, failed: true };
  }
  return { inv: invReg, regularized: true, failed: false };
}

/** Column means of a matrix (length = m). */
export function colMeans(X: Matrix): number[] {
  const n = X.length;
  const m = X[0]?.length ?? 0;
  const means = new Array<number>(m).fill(0);
  for (const row of X) {
    for (let j = 0; j < m; j++) means[j]! += row[j]! / n;
  }
  return means;
}
