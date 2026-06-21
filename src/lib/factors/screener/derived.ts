/**
 * Cohort-relative derived numerics: z-score, percentile rank.
 *
 * Locked rules (from review):
 *   • Z-score display is clipped to ±Z_DISPLAY_CLIP. Underlying raw z is
 *     preserved on the result for sort keys.
 *   • When σ_cohort is below the absolute floor (essentially constant
 *     cohort), z-mode falls back to percentile — the result carries
 *     `fellBackToPct: true` so the UI can render the percentile path
 *     and surface the fallback in the cell tooltip.
 *   • Percentile rank uses the empirical CDF average-rank convention so a
 *     value at the cohort min reports 1, the max reports 99, no edge
 *     piles up at 0 or 100.
 */
import type { ScreenerColumnStats, ScreenerZResult } from "./types";

/** Display clip on z-score (raw z preserved separately for sorting). */
export const Z_DISPLAY_CLIP = 5;

/**
 * Below this absolute σ_cohort the cohort is treated as "essentially
 * constant" and z-mode falls back to percentile. Chosen to be small enough
 * that real distributions never trigger fallback (β SDs are typically
 * 0.05+, return contribs 0.001+, R² 0.01+) yet large enough that
 * floating-point noise can't produce ±∞ z values.
 */
export const MIN_SD_FOR_Z = 1e-9;

/**
 * Compute a z-score for `value` against the given cohort stats. Returns null
 * for raw + display when stats are unavailable, when value is non-finite, or
 * when the cohort has fewer than 2 contributing rows (no SD definable).
 *
 * Callers should check `fellBackToPct` and route to the percentile renderer
 * when true.
 */
export function computeZ(
  value: number | null,
  stats: ScreenerColumnStats | null,
): ScreenerZResult {
  if (value === null || !Number.isFinite(value)) {
    return { raw: null, display: null, fellBackToPct: false };
  }
  if (!stats || stats.n < 2 || !Number.isFinite(stats.mean) || !Number.isFinite(stats.sd)) {
    return { raw: null, display: null, fellBackToPct: false };
  }
  if (stats.sd < MIN_SD_FOR_Z) {
    // Cohort is essentially constant. Caller should render percentile.
    return { raw: null, display: null, fellBackToPct: true };
  }
  const raw = (value - stats.mean) / stats.sd;
  const display = Math.max(-Z_DISPLAY_CLIP, Math.min(Z_DISPLAY_CLIP, raw));
  return { raw, display, fellBackToPct: false };
}

/**
 * Empirical-CDF percentile rank of `value` in cohort, returned as an integer
 * in [1, 99]. Uses the average-rank convention:
 *
 *   p = (count_lt + 0.5 × count_eq) / n × 100
 *
 * Then clamped to [1, 99] so cohort min/max never collapse to 0/100. Ties
 * receive the same rank.
 *
 * Returns null when stats are unavailable, value is non-finite, or the
 * cohort is empty.
 */
export function computePctRank(
  value: number | null,
  stats: ScreenerColumnStats | null,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!stats || stats.n === 0) return null;
  const sorted = stats.sortedValues;
  // Binary-search the lower and upper bounds of `value` in the sorted list.
  const lower = lowerBound(sorted, value);
  const upper = upperBound(sorted, value);
  const countLt = lower;
  const countEq = upper - lower;
  const fraction = (countLt + 0.5 * countEq) / stats.n;
  const pct = Math.round(fraction * 100);
  return Math.max(1, Math.min(99, pct));
}

/**
 * 0..1 percentile fraction (continuous version of {@link computePctRank}).
 * Used by the conditional-format heat ramp where a continuous gradient
 * looks better than 99 discrete colour steps.
 */
export function computePctFraction(
  value: number | null,
  stats: ScreenerColumnStats | null,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!stats || stats.n === 0) return null;
  const sorted = stats.sortedValues;
  const lower = lowerBound(sorted, value);
  const upper = upperBound(sorted, value);
  return (lower + 0.5 * (upper - lower)) / stats.n;
}

function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
