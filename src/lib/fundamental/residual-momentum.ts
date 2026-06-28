/**
 * Box 3 — Residual Price Momentum. Pure math, no I/O. Company-specific price
 * confirmation after removing the equal-weight subsector move. Components are
 * oriented HIGHER = BETTER (stronger residual outperformance is better).
 *
 * The subsector equal-weight benchmark return is assembled by the scoring
 * service (it holds the peer membership + price history); these helpers do the
 * window math and the residual subtraction, and are individually unit-tested.
 */

/** Trading-day offsets for the 6-1 month window (≈ 126 and 21 trading days). */
export const MOM_WINDOW_START_BACK = 126; // ~6 months
export const MOM_WINDOW_END_BACK = 21; // ~1 month (exclude the most recent month)

/**
 * Simple return over a trailing window of a chronological close series (oldest
 * -> newest): price[len-toBack] / price[len-fromBack] - 1. Null if the series
 * is too short or a boundary price is non-positive.
 */
export function trailingWindowReturn(
  closes: Array<number | null>,
  fromBack: number,
  toBack: number,
): number | null {
  if (fromBack <= toBack) return null;
  const n = closes.length;
  const startIdx = n - fromBack;
  const endIdx = n - toBack;
  if (startIdx < 0 || endIdx < 0 || endIdx >= n) return null;
  const p0 = closes[startIdx];
  const p1 = closes[endIdx];
  if (p0 == null || p1 == null || !(p0 > 0) || !(p1 > 0)) return null;
  return p1 / p0 - 1;
}

/**
 * Simple return from a given index to the last close: last / closes[fromIndex] - 1.
 * Null if the index is out of range or a boundary price is non-positive.
 */
export function returnSinceIndex(closes: Array<number | null>, fromIndex: number): number | null {
  const n = closes.length;
  if (fromIndex < 0 || fromIndex >= n) return null;
  const p0 = closes[fromIndex];
  const p1 = closes[n - 1];
  if (p0 == null || p1 == null || !(p0 > 0) || !(p1 > 0)) return null;
  return p1 / p0 - 1;
}

/**
 * Index of the last date <= `iso` in an ascending ISO date array (binary
 * search). -1 when `iso` precedes the whole series.
 */
export function indexAtOrBefore(dates: string[], iso: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= iso) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Return from the close on/just-before `fromIso` to the last close. Null if the
 * date precedes the series or a boundary price is non-positive. Used for the
 * residual-return-since-last-earnings component (AMC assumption: the prior-day
 * close anchors the move when BMO/AMC timing is unavailable).
 */
export function returnBetween(
  dates: string[],
  closes: Array<number | null>,
  fromIso: string,
): number | null {
  const idx = indexAtOrBefore(dates, fromIso);
  if (idx < 0) return null;
  return returnSinceIndex(closes, idx);
}

/** Residual = stock return minus benchmark (equal-weight subsector) return. */
export function residual(stockReturn: number | null, benchReturn: number | null): number | null {
  if (stockReturn === null || benchReturn === null) return null;
  if (!Number.isFinite(stockReturn) || !Number.isFinite(benchReturn)) return null;
  return stockReturn - benchReturn;
}

export const RESIDUAL_MOMENTUM_COMPONENT_KEYS = [
  "residual6m1m",
  "residualSinceEarnings",
] as const;

export type ResidualMomentumComponents = Record<
  (typeof RESIDUAL_MOMENTUM_COMPONENT_KEYS)[number],
  number | null
>;

export interface ResidualMomentumInputs {
  /** Stock 6-1m return minus subsector 6-1m return (computed by the service). */
  residual6m1m: number | null;
  /** Stock since-last-earnings return minus subsector same-window (or null). */
  residualSinceEarnings: number | null;
}

/** Assemble the residual-momentum components (already oriented higher = better). */
export function residualMomentumComponents(
  inputs: ResidualMomentumInputs,
): ResidualMomentumComponents {
  return {
    residual6m1m: inputs.residual6m1m,
    residualSinceEarnings: inputs.residualSinceEarnings,
  };
}
