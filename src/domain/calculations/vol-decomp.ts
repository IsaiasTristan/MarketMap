/**
 * Volatility decomposition: systematic vs idiosyncratic share.
 * Uses R² from regression of portfolio returns on the market factor.
 */
import { ols } from "./beta";

export interface VolDecomp {
  systematicShare: number; // R² from market regression
  idiosyncraticShare: number; // 1 - R²
  rSquared: number;
}

export function volDecomposition(
  portfolioReturns: number[],
  marketReturns: number[],
): VolDecomp {
  const { rSquared } = ols(portfolioReturns, marketReturns);
  return {
    systematicShare: rSquared,
    idiosyncraticShare: 1 - rSquared,
    rSquared,
  };
}
