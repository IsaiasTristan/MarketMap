/**
 * Pairs tab — spread + basket price math. No I/O.
 *
 * Price history is used for exactly four jobs and no others (brief §2):
 * qualification (hedge efficiency), the already-noticed check (price ratio),
 * risk measurement (spread vol / drawdown / worst month / leg correlation), and
 * calibration. It NEVER ranks pairs. Everything here operates on the pair's own
 * weekly total-return series.
 */

const WEEKS_PER_YEAR = 52;

/** Simple week-over-week returns from a close series (null-propagating). */
export function weeklyReturnsFromCloses(closes: Array<number | null>): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && a > 0) {
      out[i] = b / a - 1;
    }
  }
  return out;
}

/**
 * Basket weekly returns from each member's aligned weekly-return series. Equal
 * weight by default; pass per-member weights (e.g. market caps) for cap weight.
 * A week's basket return is the (weighted) mean over members with a finite
 * return that week; null when none.
 */
export function basketWeeklyReturns(
  memberReturns: Array<Array<number | null>>,
  weights?: number[],
): Array<number | null> {
  if (memberReturns.length === 0) return [];
  const weeks = Math.max(...memberReturns.map((m) => m.length));
  const out: Array<number | null> = new Array(weeks).fill(null);
  for (let w = 0; w < weeks; w++) {
    let sum = 0;
    let wsum = 0;
    for (let m = 0; m < memberReturns.length; m++) {
      const r = memberReturns[m]![w];
      if (r === null || r === undefined || !Number.isFinite(r)) continue;
      const wt = weights ? Math.max(0, weights[m] ?? 0) : 1;
      if (wt <= 0) continue;
      sum += r * wt;
      wsum += wt;
    }
    out[w] = wsum > 0 ? sum / wsum : null;
  }
  return out;
}

/**
 * Total-return index from a return series, indexed to `start` at the first
 * finite point. Null returns are treated as flat (carry the level) so a single
 * missing week never resets the compounding chain.
 */
export function indexFromReturns(returns: Array<number | null>, start = 100): Array<number | null> {
  const out: Array<number | null> = new Array(returns.length).fill(null);
  let level: number | null = null;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (level === null) {
      // Start the index at the first week we can anchor (index 0 or first finite return).
      if (i === 0) {
        level = start;
        out[i] = start;
        continue;
      }
      level = start;
    }
    if (r !== null && Number.isFinite(r)) level = level * (1 + r);
    out[i] = level;
  }
  return out;
}

/** Price ratio (long index / short index) per week; null when either missing. */
export function priceRatioSeries(
  longIndex: Array<number | null>,
  shortIndex: Array<number | null>,
): Array<number | null> {
  const n = Math.min(longIndex.length, shortIndex.length);
  const out: Array<number | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const a = longIndex[i];
    const b = shortIndex[i];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && b !== 0) out[i] = a / b;
  }
  return out;
}

/** Compound return of a return series over its trailing `weeks` finite values. */
function trailingCompound(returns: Array<number | null>, weeks: number): number | null {
  const tail = returns.slice(Math.max(0, returns.length - weeks));
  let acc = 1;
  let seen = 0;
  for (const r of tail) {
    if (r === null || !Number.isFinite(r)) continue;
    acc *= 1 + r;
    seen++;
  }
  return seen === 0 ? null : acc - 1;
}

/** Long-leg return minus short-leg return over the trailing `weeks`. */
export function relReturn(
  longReturns: Array<number | null>,
  shortReturns: Array<number | null>,
  weeks: number,
): number | null {
  const l = trailingCompound(longReturns, weeks);
  const s = trailingCompound(shortReturns, weeks);
  if (l === null || s === null) return null;
  return l - s;
}

/** Aligned finite (long, short) return pairs over the trailing `weeks`. */
function alignedPairs(
  longReturns: Array<number | null>,
  shortReturns: Array<number | null>,
  weeks?: number,
): Array<[number, number]> {
  const n = Math.min(longReturns.length, shortReturns.length);
  const from = weeks ? Math.max(0, n - weeks) : 0;
  const pairs: Array<[number, number]> = [];
  for (let i = from; i < n; i++) {
    const a = longReturns[i];
    const b = shortReturns[i];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  return pairs;
}

function sampleVar(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

/**
 * Hedge efficiency = 1 - Var(rL - rS) / (Var(rL) + Var(rS)), from ~2y weekly
 * total returns (brief §3). Algebraically 2*Cov / (VarL + VarS): a
 * correlation-like number that ALSO penalises a volatility mismatch between the
 * legs (plain correlation does not). >=0.7 tight, 0.4-0.7 workable, <0.30 not a
 * pair, negative means the "hedge" doubles risk. Null with <8 aligned weeks.
 */
export function hedgeEfficiency(
  longReturns: Array<number | null>,
  shortReturns: Array<number | null>,
  weeks?: number,
): number | null {
  const pairs = alignedPairs(longReturns, shortReturns, weeks);
  if (pairs.length < 8) return null;
  const rl = pairs.map((p) => p[0]);
  const rs = pairs.map((p) => p[1]);
  const spread = pairs.map((p) => p[0] - p[1]);
  const denom = sampleVar(rl) + sampleVar(rs);
  if (denom < 1e-18) return null;
  return 1 - sampleVar(spread) / denom;
}

export interface SpreadRisk {
  /** Annualized spread volatility (weekly sigma * sqrt(52)). */
  annualizedVol: number | null;
  /** Worst peak-to-trough drawdown of the compounding spread index (fraction, <=0). */
  maxDrawdown: number | null;
  /** Worst single-week spread return (fraction). */
  worstWeek: number | null;
  /** Pearson correlation of the two legs over the window. */
  legCorrelation: number | null;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx < 1e-18 || vy < 1e-18) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Risk readouts on the dollar-neutral spread (rL - rS) over the window. */
export function spreadRisk(
  longReturns: Array<number | null>,
  shortReturns: Array<number | null>,
  weeks?: number,
): SpreadRisk {
  const pairs = alignedPairs(longReturns, shortReturns, weeks);
  if (pairs.length < 2) {
    return { annualizedVol: null, maxDrawdown: null, worstWeek: null, legCorrelation: null };
  }
  const spread = pairs.map((p) => p[0] - p[1]);
  const vol = Math.sqrt(sampleVar(spread)) * Math.sqrt(WEEKS_PER_YEAR);
  // Drawdown of the compounding spread index.
  let level = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of spread) {
    level *= 1 + r;
    if (level > peak) peak = level;
    const dd = level / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }
  const worstWeek = Math.min(...spread);
  const legCorrelation = pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  return { annualizedVol: vol, maxDrawdown: maxDd, worstWeek, legCorrelation };
}

/**
 * priceRatioZ: today's ratio vs its own trailing mean, in standard deviations
 * (context only — a stretched ratio WITH signal support means you are late, not
 * wrong). Null with <8 finite ratio observations.
 */
export function priceRatioZ(ratioSeries: Array<number | null>, windowWeeks?: number): number | null {
  const finite = ratioSeries.filter((v): v is number => v !== null && Number.isFinite(v));
  const window = windowWeeks ? finite.slice(Math.max(0, finite.length - windowWeeks)) : finite;
  if (window.length < 8) return null;
  const last = window[window.length - 1]!;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1));
  if (sd < 1e-12) return null;
  return (last - mean) / sd;
}
