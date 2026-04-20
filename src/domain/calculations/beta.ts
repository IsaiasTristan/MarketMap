/**
 * Beta, alpha, and tracking error calculations.
 * OLS via closed-form formula for speed (no external dependency).
 */

const TRADING_DAYS = 252;

/** Simple OLS: returns { beta, alpha, rSquared }. */
export function ols(
  y: number[],
  x: number[],
): { beta: number; alpha: number; rSquared: number } {
  const n = Math.min(y.length, x.length);
  if (n < 2) return { beta: 1, alpha: 0, rSquared: 0 };

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXX += x[i] * x[i];
    sumXY += x[i] * y[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumXX - n * meanX * meanX;
  const beta = denom !== 0 ? (sumXY - n * meanX * meanY) / denom : 1;
  const alpha = meanY - beta * meanX;

  // R²
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const yhat = alpha + beta * x[i];
    ssTot += (y[i] - meanY) ** 2;
    ssRes += (y[i] - yhat) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { beta, alpha, rSquared };
}

/** Vasicek-adjusted beta: 0.67 × raw_beta + 0.33 × 1.0 */
export function vasicekBeta(rawBeta: number): number {
  return 0.67 * rawBeta + 0.33;
}

/** Rolling 252-day Vasicek-adjusted beta of stock vs benchmark. */
export function rollingBeta(
  stockReturns: number[],
  benchmarkReturns: number[],
  window = 252,
): number[] {
  const n = Math.min(stockReturns.length, benchmarkReturns.length);
  const out = new Array(n).fill(NaN);
  for (let i = window; i <= n; i++) {
    const y = stockReturns.slice(i - window, i);
    const x = benchmarkReturns.slice(i - window, i);
    const { beta } = ols(y, x);
    out[i - 1] = vasicekBeta(beta);
  }
  return out;
}

/** Jensen's alpha (annualized). αdaily × 252. */
export function jensensAlpha(
  portfolioReturns: number[],
  benchmarkReturns: number[],
  annualRf: number,
): number {
  const rfDaily = annualRf / TRADING_DAYS;
  const portExcess = portfolioReturns.map((r) => r - rfDaily);
  const benchExcess = benchmarkReturns.map((r) => r - rfDaily);
  const { alpha } = ols(portExcess, benchExcess);
  return alpha * TRADING_DAYS;
}

/** Tracking error: std of daily return differences × √252. */
export function trackingError(
  portfolioReturns: number[],
  benchmarkReturns: number[],
): number {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (n < 2) return NaN;
  const diffs = portfolioReturns.slice(0, n).map((r, i) => r - benchmarkReturns[i]);
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

/** Rolling 63-day correlation. */
export function rollingCorrelation(
  xs: number[],
  ys: number[],
  window = 63,
): number[] {
  const n = Math.min(xs.length, ys.length);
  const out = new Array(n).fill(NaN);
  for (let i = window; i <= n; i++) {
    const sx = xs.slice(i - window, i);
    const sy = ys.slice(i - window, i);
    out[i - 1] = pearsonCorr(sx, sy);
  }
  return out;
}

export function pearsonCorr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx2 += (xs[i] - mx) ** 2;
    dy2 += (ys[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}
