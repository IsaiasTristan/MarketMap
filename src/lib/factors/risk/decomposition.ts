/**
 * Factor risk decomposition using the Euler decomposition of portfolio variance.
 *
 * σ²_p = β'Σβ + σ²_idio
 *
 * where:
 *   β     = portfolio factor loading vector (k × 1)
 *   Σ     = annualized factor covariance matrix (k × k)
 *   σ²_idio = variance of residuals from the regression (annualized)
 *
 * Marginal contribution to risk (volatility):
 *   MCR_f = (Σβ)_f / σ_p        (∂σ_p / ∂β_f)
 *
 * Risk contribution per factor (Euler decomposition):
 *   RC_f  = β_f × MCR_f          (sums to σ_p when idio included via RC_idio = σ²_idio / σ_p)
 *
 * Percent contribution to total variance:
 *   PCR_f = β_f × (Σβ)_f / σ²_p
 */
import type { RiskDecomposition, FactorRiskEntry } from "@/types/factors";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";
import { matVec } from "../regression/matrix";

export function computeRiskDecomposition(
  betas: number[],
  covMatrix: number[][],
  idiosyncraticDailyVar: number,
  factorCodes: FactorCode[],
  covWindow: number,
): RiskDecomposition {
  const k = betas.length;
  if (k === 0 || covMatrix.length === 0) {
    return emptyDecomp(factorCodes, covMatrix, covWindow);
  }

  // Σβ (k vector)
  const sigmaBeta = matVec(covMatrix, betas);

  // Systematic variance: β'Σβ (annualized, since Σ is annualized)
  const systematicVar = betas.reduce((s, b, i) => s + b * (sigmaBeta[i] ?? 0), 0);

  // Idiosyncratic variance (annualized)
  const idiosyncraticVar = idiosyncraticDailyVar * 252;

  // Total portfolio variance
  const totalVar = Math.max(systematicVar + idiosyncraticVar, 1e-16);
  const totalVol = Math.sqrt(totalVar);
  const systematicVol = Math.sqrt(Math.max(0, systematicVar));
  const idiosyncraticVol = Math.sqrt(Math.max(0, idiosyncraticVar));

  const factors: FactorRiskEntry[] = factorCodes.map((code, i) => {
    const beta = betas[i] ?? 0;
    const sigBetaI = sigmaBeta[i] ?? 0;
    const marginalCR = totalVol > 0 ? sigBetaI / totalVol : 0;
    const riskContrib = totalVol > 0 ? beta * sigBetaI / totalVol : 0;
    const pctVarianceContrib = totalVar > 0 ? beta * sigBetaI / totalVar : 0;

    return {
      code,
      label: getFactorDef(code).label,
      beta,
      marginalCR,
      riskContrib,
      pctVarianceContrib,
    };
  });

  return {
    totalVolatility: totalVol,
    systematicVolatility: systematicVol,
    idiosyncraticVolatility: idiosyncraticVol,
    systematicShare: totalVar > 0 ? systematicVar / totalVar : 0,
    idiosyncraticShare: totalVar > 0 ? idiosyncraticVar / totalVar : 0,
    factors,
    covMatrix,
    covMatrixWindow: covWindow,
  };
}

function emptyDecomp(
  factorCodes: FactorCode[],
  covMatrix: number[][],
  covWindow: number,
): RiskDecomposition {
  return {
    totalVolatility: 0,
    systematicVolatility: 0,
    idiosyncraticVolatility: 0,
    systematicShare: 0,
    idiosyncraticShare: 0,
    factors: factorCodes.map((code) => ({
      code,
      label: getFactorDef(code).label,
      beta: 0,
      marginalCR: 0,
      riskContrib: 0,
      pctVarianceContrib: 0,
    })),
    covMatrix,
    covMatrixWindow: covWindow,
  };
}
