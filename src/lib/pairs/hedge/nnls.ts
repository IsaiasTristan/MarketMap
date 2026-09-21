/**
 * Non-negative least squares (Lawson-Hanson) + Cholesky + a risk-only hedge
 * basket builder. The repo has no NNLS/QP solver, so this is genuinely new.
 *
 * Hedge construction. We want non-negative SHORT weights w over a candidate
 * pool that minimise the residual variance of the hedged long,
 *
 *   min_w  (β_L − Bw)′ Σ (β_L − Bw) + Σ_i w_i² σ²_i     s.t. w ≥ 0
 *
 * where B stacks the candidates' factor-beta vectors as columns, Σ is the
 * annualised factor covariance, and σ²_i is candidate i's idiosyncratic
 * variance (shorting a name re-introduces its own idio risk, so it is penalised).
 * With Σ = LLᵀ (Cholesky) the objective is a plain least-squares fit
 *
 *   A = [ Lᵀ B ; D^{1/2} ],   b = [ Lᵀ β_L ; 0 ],   D = diag(σ²_i)
 *   min_w ‖A w − b‖²  s.t. w ≥ 0
 *
 * solved by NNLS. Greedy forward selection then trims to a small basket and a
 * per-name cap keeps any single short from dominating. Pure, no I/O.
 */

import { invert, matVec, transpose, type Matrix } from "../../factors/regression/matrix";

/**
 * Cholesky factorisation Σ = L Lᵀ (L lower-triangular). Adds a tiny jitter to
 * the diagonal if a pivot is non-positive (Σ from a sample covariance can be
 * numerically semidefinite). Returns L.
 */
export function cholesky(sigma: Matrix): Matrix {
  const n = sigma.length;
  const L: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const jitter = 1e-12;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = sigma[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        L[i]![j] = Math.sqrt(Math.max(sum, jitter));
      } else {
        const d = L[j]![j]!;
        L[i]![j] = d > 0 ? sum / d : 0;
      }
    }
  }
  return L;
}

function colOfMatrix(A: Matrix, j: number): number[] {
  return A.map((row) => row[j] ?? 0);
}

/** Ordinary least squares on a column subset of A via normal equations. */
function lstsqSubset(A: Matrix, b: number[], cols: number[]): number[] | null {
  const p = cols.length;
  if (p === 0) return [];
  const n = A.length;
  // Ap: n × p
  const Ap: Matrix = Array.from({ length: n }, (_, i) => cols.map((c) => A[i]![c]!));
  const ApT = transpose(Ap); // p × n
  // Normal matrix ApT·Ap (p × p) and rhs ApT·b (p)
  const G: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let a = 0; a < p; a++) {
    for (let c = a; c < p; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += ApT[a]![i]! * ApT[c]![i]!;
      G[a]![c] = s;
      G[c]![a] = s;
    }
  }
  const rhs = matVec(ApT, b);
  const Ginv = invert(G);
  if (!Ginv) return null;
  return matVec(Ginv, rhs);
}

/**
 * Lawson-Hanson NNLS: min ‖A x − b‖² subject to x ≥ 0.
 * A is n×m, b is length n. Returns x (length m, all ≥ 0).
 */
export function nnls(A: Matrix, b: number[], maxIter = 200, tol = 1e-10): number[] {
  const n = A.length;
  const m = A[0]?.length ?? 0;
  const x = new Array<number>(m).fill(0);
  const passive = new Array<boolean>(m).fill(false);

  const AT = transpose(A); // m × n
  // gradient w = Aᵀ(b − Ax)
  const gradient = (): number[] => {
    const Ax = matVec(A, x);
    const resid = b.map((bi, i) => bi - (Ax[i] ?? 0));
    return matVec(AT, resid);
  };

  let iter = 0;
  while (iter++ < maxIter) {
    const w = gradient();
    // pick the most-positive gradient among currently-active (zeroed) vars
    let jMax = -1;
    let wMax = tol;
    for (let j = 0; j < m; j++) {
      if (!passive[j] && w[j]! > wMax) {
        wMax = w[j]!;
        jMax = j;
      }
    }
    if (jMax === -1) break; // KKT satisfied

    passive[jMax] = true;

    // inner loop
    let inner = 0;
    while (inner++ < maxIter) {
      const cols: number[] = [];
      for (let j = 0; j < m; j++) if (passive[j]) cols.push(j);
      const z = lstsqSubset(A, b, cols);
      if (!z) {
        passive[jMax] = false;
        break;
      }
      // map z back to full space
      const zFull = new Array<number>(m).fill(0);
      cols.forEach((c, idx) => {
        zFull[c] = z[idx]!;
      });

      let minZ = Infinity;
      for (const c of cols) minZ = Math.min(minZ, zFull[c]!);
      if (minZ > tol) {
        for (let j = 0; j < m; j++) x[j] = zFull[j]!;
        break;
      }

      // find step alpha to keep feasibility
      let alpha = Infinity;
      for (const c of cols) {
        if (zFull[c]! <= tol) {
          const denom = x[c]! - zFull[c]!;
          if (denom > 0) alpha = Math.min(alpha, x[c]! / denom);
        }
      }
      if (!Number.isFinite(alpha)) alpha = 0;
      for (let j = 0; j < m; j++) x[j] = x[j]! + alpha * (zFull[j]! - x[j]!);
      // drop vars that hit zero
      for (const c of cols) {
        if (x[c]! <= tol) {
          x[c] = 0;
          passive[c] = false;
        }
      }
    }
  }
  return x.map((v) => (v < 0 ? 0 : v));
}

export interface HedgeCandidate {
  key: string;
  beta: number[];
  sigmaIdio2: number;
}

export interface HedgeBasketResult {
  legs: { key: string; weight: number }[];
  factorRiskRemovedPct: number;
  totalVarRemovedPct: number;
  residualSharePct: number;
}

function quad(v: number[], sigma: Matrix): number {
  const sv = matVec(sigma, v);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) * (sv[i] ?? 0);
  return s;
}

/** Build A/b for a candidate subset and solve NNLS; returns weights per subset index. */
function solveSubset(
  betaLong: number[],
  subset: HedgeCandidate[],
  Lt: Matrix,
  sigma: Matrix,
): number[] {
  const k = betaLong.length;
  const m = subset.length;
  // Factor block: (Lᵀ B) is k × m
  const factorBlock: Matrix = Array.from({ length: k }, (_, r) =>
    subset.map((c) => {
      // (Lᵀ β_c)_r = Σ_j Lt[r][j] * β_c[j]
      let s = 0;
      for (let j = 0; j < k; j++) s += Lt[r]![j]! * (c.beta[j] ?? 0);
      return s;
    }),
  );
  // Idio block: diag(σ_i) — m × m
  const idioBlock: Matrix = Array.from({ length: m }, (_, r) =>
    subset.map((c, cIdx) => (cIdx === r ? Math.sqrt(Math.max(c.sigmaIdio2, 0)) : 0)),
  );
  const A: Matrix = [...factorBlock, ...idioBlock];
  const bFactor = matVec(Lt, betaLong); // Lᵀ β_L (length k)
  const b = [...bFactor, ...new Array<number>(m).fill(0)];
  void sigma;
  return nnls(A, b);
}

/**
 * Greedy forward selection of a risk-only hedge basket.
 * Repeatedly adds the candidate that most reduces residual factor variance
 * (re-solving NNLS over the growing selection) until `maxNames` or no material
 * improvement. Applies a per-name cap (fraction of gross short) post-solve.
 */
export function buildHedgeBasket(params: {
  betaLong: number[];
  candidates: HedgeCandidate[];
  cov: Matrix;
  sigmaLongIdio2: number;
  maxNames: number;
  nameCap: number;
}): HedgeBasketResult {
  const { betaLong, candidates, cov, sigmaLongIdio2, maxNames, nameCap } = params;
  const L = cholesky(cov);
  const Lt = transpose(L);
  const factorVarLong = quad(betaLong, cov);
  const totalVarLong = factorVarLong + sigmaLongIdio2;

  const residualOf = (subset: HedgeCandidate[], weights: number[]): number => {
    const net = betaLong.map((b, j) => {
      let acc = b;
      subset.forEach((c, i) => {
        acc -= weights[i]! * (c.beta[j] ?? 0);
      });
      return acc;
    });
    return quad(net, cov);
  };

  const selected: HedgeCandidate[] = [];
  const remaining = [...candidates];
  let bestWeights: number[] = [];
  let bestResidual = factorVarLong;

  while (selected.length < maxNames && remaining.length > 0) {
    let bestIdx = -1;
    let bestTrialResidual = bestResidual;
    let bestTrialWeights: number[] = [];
    for (let i = 0; i < remaining.length; i++) {
      const trial = [...selected, remaining[i]!];
      const w = solveSubset(betaLong, trial, Lt, cov);
      const res = residualOf(trial, w);
      if (res < bestTrialResidual - 1e-12) {
        bestTrialResidual = res;
        bestIdx = i;
        bestTrialWeights = w;
      }
    }
    if (bestIdx === -1) break;
    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
    bestWeights = bestTrialWeights;
    bestResidual = bestTrialResidual;
  }

  // Per-name cap: clip any weight above nameCap × gross, one pass.
  let gross = bestWeights.reduce((s, w) => s + w, 0);
  if (gross > 0 && nameCap < 1) {
    const cap = nameCap * gross;
    bestWeights = bestWeights.map((w) => Math.min(w, cap));
    gross = bestWeights.reduce((s, w) => s + w, 0);
  }

  const legs = selected
    .map((c, i) => ({ key: c.key, weight: bestWeights[i] ?? 0 }))
    .filter((leg) => leg.weight > 1e-8);

  const netResidual = residualOf(selected, bestWeights);
  const factorRiskRemovedPct = factorVarLong > 0 ? 1 - netResidual / factorVarLong : 0;

  // Total variance removed: reduction in Var(long − basket).
  // Var added by idio of shorts = Σ w_i² σ²_i.
  const idioAdded = selected.reduce(
    (s, c, i) => s + (bestWeights[i] ?? 0) ** 2 * c.sigmaIdio2,
    0,
  );
  const hedgedTotalVar = netResidual + sigmaLongIdio2 + idioAdded;
  const totalVarRemovedPct = totalVarLong > 0 ? 1 - hedgedTotalVar / totalVarLong : 0;
  const residualSharePct = totalVarLong > 0 ? (100 * hedgedTotalVar) / totalVarLong : 0;

  return { legs, factorRiskRemovedPct, totalVarRemovedPct, residualSharePct };
}
