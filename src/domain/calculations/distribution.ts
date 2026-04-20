/**
 * Return distribution statistics and histogram generation.
 */

/** Sample mean. */
function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation. */
function std(xs: number[]): number {
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Fisher skewness. */
export function skewness(returns: number[]): number {
  const n = returns.length;
  if (n < 3) return NaN;
  const m = mean(returns);
  const s = std(returns);
  if (s === 0) return 0;
  const sum = returns.reduce((acc, r) => acc + ((r - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

/** Excess kurtosis (kurtosis - 3). */
export function excessKurtosis(returns: number[]): number {
  const n = returns.length;
  if (n < 4) return NaN;
  const m = mean(returns);
  const s = std(returns);
  if (s === 0) return 0;
  const sum = returns.reduce((acc, r) => acc + ((r - m) / s) ** 4, 0);
  const kurt =
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return kurt;
}

export interface HistogramBin {
  rangeMin: number;
  rangeMax: number;
  label: string;
  count: number;
  normalDensity: number; // scaled to count for overlay
}

/** Generate a histogram of daily returns with a fitted normal density. */
export function returnHistogram(
  returns: number[],
  numBins = 30,
): HistogramBin[] {
  if (!returns.length) return [];
  const sorted = [...returns].sort((a, b) => a - b);
  const minVal = sorted[0];
  const maxVal = sorted[sorted.length - 1];
  const range = maxVal - minVal || 0.001;
  const binWidth = range / numBins;

  const bins: HistogramBin[] = Array.from({ length: numBins }, (_, i) => {
    const rangeMin = minVal + i * binWidth;
    const rangeMax = rangeMin + binWidth;
    const pct = ((rangeMin + rangeMax) / 2) * 100;
    return {
      rangeMin,
      rangeMax,
      label: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      count: 0,
      normalDensity: 0,
    };
  });

  for (const r of returns) {
    const idx = Math.min(numBins - 1, Math.floor((r - minVal) / binWidth));
    if (idx >= 0) bins[idx].count++;
  }

  // Normal density
  const m = mean(returns);
  const s = std(returns);
  const n = returns.length;
  for (const bin of bins) {
    const x = (bin.rangeMin + bin.rangeMax) / 2;
    const density =
      (1 / (s * Math.sqrt(2 * Math.PI))) *
      Math.exp(-0.5 * ((x - m) / s) ** 2);
    bin.normalDensity = density * n * binWidth;
  }

  return bins;
}

/** Monthly return calendar — returns a map of "YYYY-MM" → simple return. */
export function monthlyReturnCalendar(
  dates: string[],
  dailyReturns: number[],
): Record<string, number> {
  const monthly: Record<string, number[]> = {};
  for (let i = 0; i < dates.length; i++) {
    const key = dates[i].slice(0, 7); // YYYY-MM
    if (!monthly[key]) monthly[key] = [];
    monthly[key].push(dailyReturns[i]);
  }

  const out: Record<string, number> = {};
  for (const [month, rets] of Object.entries(monthly)) {
    // Compound monthly return from daily
    const compound = rets.reduce((nav, r) => nav * (1 + r), 1) - 1;
    out[month] = compound;
  }
  return out;
}

/** Rolling N-day annualized return series. */
export function rolling12mReturn(dailyReturns: number[], window = 252): number[] {
  const out: number[] = new Array(dailyReturns.length).fill(NaN);
  for (let i = window; i <= dailyReturns.length; i++) {
    const slice = dailyReturns.slice(i - window, i);
    const compound = slice.reduce((nav, r) => nav * (1 + r), 1) - 1;
    out[i - 1] = compound;
  }
  return out;
}

/**
 * Rolling annualized Sharpe ratio over a sliding window.
 * Each point = Sharpe of the preceding `window` daily returns.
 * Points before `window` days are NaN.
 */
export function rollingSharpeRatio(
  dailyReturns: number[],
  annualRf: number,
  window = 63,
): number[] {
  const dailyRf = annualRf / 252;
  const out: number[] = new Array(dailyReturns.length).fill(NaN);
  for (let i = window; i <= dailyReturns.length; i++) {
    const slice = dailyReturns.slice(i - window, i);
    const m = slice.reduce((s, r) => s + r, 0) / slice.length;
    const variance = slice.reduce((s, r) => s + (r - m) ** 2, 0) / (slice.length - 1);
    const s = Math.sqrt(variance);
    if (s > 0) {
      out[i - 1] = ((m - dailyRf) * 252) / (s * Math.sqrt(252));
    }
  }
  return out;
}
