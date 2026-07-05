/**
 * Fund returns engine — read-time chaining, trailing windows, clone alpha (Part 1).
 * Pure & DB-free. The per-quarter snapshot/clone returns are precomputed and
 * persisted; the trailing windows are chained here at READ time from the ordered
 * series, so a config change to window definitions never needs a recompute.
 *
 * Gap discipline: the input series is expected to be CALENDAR-CONTIGUOUS — one
 * entry per quarter-end, `ret: null` where a quarter has no usable data (a dead or
 * newly-born fund, or a coverage hole). A window that contains any null, or is
 * longer than the available history, renders "insufficient history" — never a
 * padded or hole-compounded number.
 */

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Quarters per trailing window. 2Y+ (> 4q) is shown annualized (geometric). */
export const WINDOW_QUARTERS: Record<string, number> = { "1Q": 1, "6M": 2, "1Y": 4, "2Y": 8 };
/** A window longer than this many quarters is annualized geometrically. */
const ANNUALIZE_ABOVE_Q = 4;
const QUARTERS_PER_YEAR = 4;

export interface QuarterReturn {
  /** Quarter-end (YYYY-MM-DD). Series is ascending; most-recent last. */
  period: string;
  /** Book/clone return for the quarter (fraction), or null when no usable data. */
  ret: number | null;
}

export interface WindowResult {
  /** Cumulative return, or annualized for > 4q windows (fraction); null if insufficient. */
  ret: number | null;
  annualized: boolean;
  insufficient: boolean;
  /** Quarters actually backing the figure (= windowQuarters when sufficient). */
  quarters: number;
}

/** Compound a contiguous list of quarterly returns: Π(1 + r) − 1. */
export function chainReturns(quarterly: number[]): number {
  return round4(quarterly.reduce((acc, r) => acc * (1 + r), 1) - 1);
}

/**
 * Trailing window over the last `windowQuarters` entries of a calendar-contiguous
 * series. Any null in the window, or history shorter than the window, ⇒
 * insufficient (never padded). Windows > 4q are annualized geometrically.
 */
export function trailingWindow(series: QuarterReturn[], windowQuarters: number): WindowResult {
  if (series.length < windowQuarters) {
    return { ret: null, annualized: windowQuarters > ANNUALIZE_ABOVE_Q, insufficient: true, quarters: series.length };
  }
  const tail = series.slice(series.length - windowQuarters);
  const vals: number[] = [];
  for (const q of tail) {
    if (q.ret == null || !Number.isFinite(q.ret)) {
      return { ret: null, annualized: windowQuarters > ANNUALIZE_ABOVE_Q, insufficient: true, quarters: windowQuarters };
    }
    vals.push(q.ret);
  }
  const chained = chainReturns(vals);
  if (windowQuarters > ANNUALIZE_ABOVE_Q) {
    const annual = Math.pow(1 + chained, QUARTERS_PER_YEAR / windowQuarters) - 1;
    return { ret: round4(annual), annualized: true, insufficient: false, quarters: windowQuarters };
  }
  return { ret: chained, annualized: false, insufficient: false, quarters: windowQuarters };
}

/** Excess of a window return vs the benchmark's return over the SAME window basis. */
export function windowExcess(fundRet: number | null, benchRet: number | null): number | null {
  if (fundRet == null || benchRet == null || !Number.isFinite(fundRet) || !Number.isFinite(benchRet)) return null;
  return round4(fundRet - benchRet);
}

export interface CloneAlphaResult {
  /** Annualized excess of the chained clone series vs the benchmark (fraction). */
  alpha: number | null;
  /** Quarters where BOTH clone and benchmark returns were usable. */
  quarters: number;
}

/**
 * Full-history clone alpha: annualized clone return minus annualized benchmark
 * return over the quarters where both are usable. Both arrays are aligned by
 * quarter (same index = same quarter); a quarter is used only when BOTH are finite.
 */
export function cloneAlpha(cloneQtrly: Array<number | null>, benchQtrly: Array<number | null>): CloneAlphaResult {
  const n = Math.min(cloneQtrly.length, benchQtrly.length);
  const clone: number[] = [];
  const bench: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = cloneQtrly[i];
    const b = benchQtrly[i];
    if (c != null && b != null && Number.isFinite(c) && Number.isFinite(b)) {
      clone.push(c);
      bench.push(b);
    }
  }
  if (clone.length === 0) return { alpha: null, quarters: 0 };
  const q = clone.length;
  const chainedClone = chainReturns(clone);
  const chainedBench = chainReturns(bench);
  const annClone = Math.pow(1 + chainedClone, QUARTERS_PER_YEAR / q) - 1;
  const annBench = Math.pow(1 + chainedBench, QUARTERS_PER_YEAR / q) - 1;
  return { alpha: round4(annClone - annBench), quarters: q };
}

/**
 * Last split-adjusted close ON/BEFORE `asOfMs` in an ascending-by-time series.
 * Companion to base-rates.priceAsOf (which is on/after): use this for period-END
 * endpoints (snapshot return), and priceAsOf for filing-date entry (clone) — both
 * lookahead-free for their respective purpose.
 */
export function priceAsOfOnOrBefore(
  series: Array<{ t: number; px: number }>,
  asOfMs: number,
): number | null {
  // binary search for the last t <= asOfMs
  let lo = 0;
  let hi = series.length; // first index with t > asOfMs
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t <= asOfMs) lo = mid + 1;
    else hi = mid;
  }
  const p = series[lo - 1];
  return p && p.px > 0 ? p.px : null;
}
