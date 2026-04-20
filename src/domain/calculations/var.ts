/**
 * Value at Risk and Expected Shortfall calculations.
 * All inputs are daily returns. VaR is expressed in dollars.
 */

const TRADING_DAYS = 252;

// z-scores for common confidence levels
const Z_95 = 1.645;
const Z_99 = 2.326;

/** Parametric (normal) VaR in dollars.
 *  VaR = weight × portfolioValue × annVol/√252 × z
 */
export function parametricVaR(
  weight: number,
  portfolioValue: number,
  annualizedVol: number,
  zScore = Z_95,
): number {
  const dailyVol = annualizedVol / Math.sqrt(TRADING_DAYS);
  return weight * portfolioValue * dailyVol * zScore;
}

/** Historical simulation VaR at a given percentile (e.g. 0.05 = 95% VaR). */
export function historicalVaR(
  dailyPnlSeries: number[],
  percentile = 0.05,
): number {
  if (!dailyPnlSeries.length) return 0;
  const sorted = [...dailyPnlSeries].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * percentile);
  return sorted[idx] ?? sorted[0];
}

/** Expected Shortfall (CVaR): mean of returns below VaR threshold. */
export function expectedShortfall(
  dailyPnlSeries: number[],
  percentile = 0.05,
): number {
  if (!dailyPnlSeries.length) return 0;
  const sorted = [...dailyPnlSeries].sort((a, b) => a - b);
  const cutoff = Math.floor(sorted.length * percentile);
  const tail = sorted.slice(0, cutoff);
  if (!tail.length) return sorted[0] ?? 0;
  return tail.reduce((s, v) => s + v, 0) / tail.length;
}

/** Full portfolio parametric VaR using the covariance matrix. */
export function portfolioParametricVaR(
  weights: number[],
  correlationMatrix: number[][],
  individualVols: number[],
  portfolioValue: number,
  zScore = Z_95,
): number {
  const n = weights.length;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const vi = (individualVols[i] ?? 0) / Math.sqrt(TRADING_DAYS);
      const vj = (individualVols[j] ?? 0) / Math.sqrt(TRADING_DAYS);
      const rij = correlationMatrix[i]?.[j] ?? 0;
      variance += weights[i] * weights[j] * vi * vj * rij;
    }
  }
  const sigma = Math.sqrt(Math.max(0, variance));
  return portfolioValue * sigma * zScore;
}

/** Correlation-stressed VaR: force all pairwise correlations to 1 (worst case). */
export function stressedVaR(
  weights: number[],
  individualVols: number[],
  portfolioValue: number,
  zScore = Z_95,
): number {
  const n = weights.length;
  // With ρ=1: portfolio σ = Σ(wᵢ × σᵢ)
  let weightedVol = 0;
  for (let i = 0; i < n; i++) {
    weightedVol += (weights[i] ?? 0) * ((individualVols[i] ?? 0) / Math.sqrt(TRADING_DAYS));
  }
  return portfolioValue * weightedVol * zScore;
}

/** Marginal VaR via numerical differentiation: ∂VaR/∂wᵢ. */
export function marginalVaR(
  weights: number[],
  correlationMatrix: number[][],
  individualVols: number[],
  portfolioValue: number,
  zScore = Z_95,
  epsilon = 0.0001,
): number[] {
  const base = portfolioParametricVaR(weights, correlationMatrix, individualVols, portfolioValue, zScore);
  return weights.map((w, i) => {
    const perturbed = [...weights];
    perturbed[i] = w + epsilon;
    const bumped = portfolioParametricVaR(perturbed, correlationMatrix, individualVols, portfolioValue, zScore);
    return (bumped - base) / epsilon;
  });
}

/** Component VaR: wᵢ × Marginal VaRᵢ (sums to total portfolio VaR). */
export function componentVaR(
  weights: number[],
  marginalVaRs: number[],
): number[] {
  return weights.map((w, i) => w * (marginalVaRs[i] ?? 0));
}

export { Z_95, Z_99 };
