/**
 * Risk-adjusted performance metrics.
 * All inputs use daily simple returns. Annualization uses 252 trading days.
 */

const TRADING_DAYS = 252;

/** Downside deviation (semi-deviation) of daily returns below 0. */
export function downsideDeviation(dailyReturns: number[]): number {
  const negReturns = dailyReturns.filter((r) => r < 0);
  if (negReturns.length < 2) return 0;
  const meanSq = negReturns.reduce((s, r) => s + r * r, 0) / negReturns.length;
  return Math.sqrt(meanSq * TRADING_DAYS); // annualized
}

/** Sortino ratio: (annualized return - Rf) / downside deviation. */
export function sortinoRatio(
  dailyReturns: number[],
  annualRf: number,
): number {
  const n = dailyReturns.length;
  if (n < 2) return NaN;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const annReturn = mean * TRADING_DAYS;
  const dd = downsideDeviation(dailyReturns);
  return dd > 0 ? (annReturn - annualRf) / dd : NaN;
}

/** Max drawdown from peak-to-trough over the return series. Returns negative number. */
export function maxDrawdown(dailyReturns: number[]): number {
  if (!dailyReturns.length) return 0;
  let peak = 1;
  let nav = 1;
  let maxDD = 0;
  for (const r of dailyReturns) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    const dd = nav / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

/** Full drawdown time-series (fraction from peak, negative). */
export function drawdownSeries(dailyReturns: number[]): number[] {
  const out: number[] = [];
  let peak = 1;
  let nav = 1;
  for (const r of dailyReturns) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    out.push(nav / peak - 1);
  }
  return out;
}

/** Max drawdown duration in trading days. */
export function maxDrawdownDuration(dailyReturns: number[]): number {
  if (!dailyReturns.length) return 0;
  let peak = 1;
  let nav = 1;
  let ddStart = 0;
  let maxDur = 0;
  for (let i = 0; i < dailyReturns.length; i++) {
    nav *= 1 + dailyReturns[i];
    if (nav >= peak) {
      const dur = i - ddStart;
      if (dur > maxDur) maxDur = dur;
      peak = nav;
      ddStart = i;
    }
  }
  return maxDur;
}

/** Current drawdown from peak (most recent value). */
export function currentDrawdown(dailyReturns: number[]): number {
  const series = drawdownSeries(dailyReturns);
  return series.length ? series[series.length - 1] : 0;
}

/** Calmar ratio: annualized return / abs(max drawdown). */
export function calmarRatio(
  dailyReturns: number[],
): number {
  const n = dailyReturns.length;
  if (n < 2) return NaN;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const annReturn = mean * TRADING_DAYS;
  const mdd = Math.abs(maxDrawdown(dailyReturns));
  return mdd > 0 ? annReturn / mdd : NaN;
}

/** Up-capture ratio: portfolio return on up-benchmark days / benchmark return on those days × 100. */
export function upCaptureRatio(
  portfolioReturns: number[],
  benchmarkReturns: number[],
): number {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  let portSum = 0;
  let benchSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (benchmarkReturns[i] > 0) {
      portSum += portfolioReturns[i];
      benchSum += benchmarkReturns[i];
      count++;
    }
  }
  if (count === 0 || benchSum === 0) return NaN;
  return (portSum / benchSum) * 100;
}

/** Down-capture ratio: portfolio return on down-benchmark days / benchmark return on those days × 100. */
export function downCaptureRatio(
  portfolioReturns: number[],
  benchmarkReturns: number[],
): number {
  const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
  let portSum = 0;
  let benchSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (benchmarkReturns[i] < 0) {
      portSum += portfolioReturns[i];
      benchSum += benchmarkReturns[i];
      count++;
    }
  }
  if (count === 0 || benchSum === 0) return NaN;
  return (portSum / benchSum) * 100;
}
