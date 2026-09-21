/**
 * Single-name hedge ratio and risk-removed diagnostics.
 *
 * Given a long exposure β_L and one candidate short β_c (both factor-beta
 * vectors), the variance-minimising short weight of the candidate against the
 * long is the univariate regression coefficient of the long's return on the
 * candidate's return:
 *
 *   w* = Cov(r_L, r_c) / Var(r_c) = (β_L′Σβ_c) / (β_c′Σβ_c + σ²_c)
 *
 * where Σ is the annualised factor covariance and σ²_c is the candidate's
 * idiosyncratic variance. Both risk-removed figures are returned UNCLAMPED so a
 * mis-oriented or return-correlated-but-anti-factor candidate shows a negative
 * (risk-adding) value honestly. Pure, no I/O.
 */

import { matVec } from "../../factors/regression/matrix";

export interface SingleNameHedgeResult {
  /** Optimal short weight of the candidate per unit of long. */
  weight: number;
  /** Fraction of the long's FACTOR variance (β_L′Σβ_L) removed at w*. */
  factorRiskRemovedPct: number;
  /** Fraction of the long's TOTAL variance (factor + idio) removed at w*. */
  totalVarRemovedPct: number;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function singleNameHedge(
  betaLong: number[],
  betaCand: number[],
  cov: number[][],
  sigmaLongIdio2: number,
  sigmaCandIdio2: number,
): SingleNameHedgeResult {
  const sigmaBetaCand = matVec(cov, betaCand); // Σβ_c
  const covLongCand = dot(betaLong, sigmaBetaCand); // β_L′Σβ_c
  const varCand = dot(betaCand, sigmaBetaCand) + sigmaCandIdio2; // β_c′Σβ_c + σ²_c

  const weight = varCand > 0 ? covLongCand / varCand : 0;

  const factorVarLong = dot(betaLong, matVec(cov, betaLong)); // β_L′Σβ_L
  const totalVarLong = factorVarLong + sigmaLongIdio2;

  // Net factor exposure after shorting w units of the candidate.
  const net = betaLong.map((b, j) => b - weight * (betaCand[j] ?? 0));
  const netFactorVar = dot(net, matVec(cov, net));
  const factorRiskRemovedPct = factorVarLong > 0 ? 1 - netFactorVar / factorVarLong : 0;

  // Reduction in TOTAL variance: Var(r_L) − Var(r_L − w r_c)
  //   = 2w·Cov(r_L,r_c) − w²·Var(r_c).  (idio of L and c are independent)
  const totalVarRemoved = 2 * weight * covLongCand - weight * weight * varCand;
  const totalVarRemovedPct = totalVarLong > 0 ? totalVarRemoved / totalVarLong : 0;

  return { weight, factorRiskRemovedPct, totalVarRemovedPct };
}
