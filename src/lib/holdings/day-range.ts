/**
 * Day-range bar helpers for intraday low/high visualization.
 */

/** Marker position in [0, 1] along the day low→high span. */
export function dayRangeMarkerPosition(
  low: number,
  high: number,
  price: number,
): number {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, (price - low) / (high - low)));
}

/** Signed period return: (current - start) / start, sign-adjusted for shorts. */
export function signedPeriodReturn(
  current: number,
  start: number,
  isShort: boolean,
): number {
  if (start <= 0 || !Number.isFinite(current) || !Number.isFinite(start)) {
    return 0;
  }
  const sign = isShort ? -1 : 1;
  return sign * (current - start) / start;
}
