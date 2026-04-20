/**
 * Factor sensitivity table: best/worst case impacts at ±1σ and ±2σ shocks.
 *
 * σ_f is the annualized factor standard deviation; we convert to a
 * comparable single-period shock using σ_f / √252.
 */
import type { FactorCode, SensitivityEntry } from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

/**
 * Build a sensitivity table showing the portfolio impact of ±1σ and ±2σ
 * single-factor shocks for each factor in the model.
 *
 * @param portfolioBetas   Portfolio factor betas (same order as factorCodes).
 * @param factorCodes      Factor codes.
 * @param factorAnnualVols Annualized factor volatilities (from covariance diagonals).
 */
export function computeSensitivityTable(
  portfolioBetas: number[],
  factorCodes: FactorCode[],
  factorAnnualVols: number[],
): SensitivityEntry[] {
  return factorCodes.map((code, i) => {
    const beta = portfolioBetas[i] ?? 0;
    const annualVol = factorAnnualVols[i] ?? 0;
    // Convert annualized vol to a "1-day equivalent" shock for scaling intuition
    // but display shocks in annualized terms since that's what investors recognize
    const sigma = annualVol;

    return {
      code,
      label: getFactorDef(code).label,
      beta,
      shock1Sig: sigma,
      shock2Sig: 2 * sigma,
      impact1Sig: beta * sigma,
      impact2Sig: beta * 2 * sigma,
      impactNeg1Sig: beta * -sigma,
      impactNeg2Sig: beta * -2 * sigma,
    };
  });
}
