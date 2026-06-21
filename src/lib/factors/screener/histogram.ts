/**
 * Histogram + three-tick fallback computation for the column-header
 * distribution strip.
 *
 * Two display modes:
 *   • n ≥ MIN_HISTOGRAM_N  → equal-width binned histogram
 *   • n < MIN_HISTOGRAM_N  → three-tick min/median/max indicator (small
 *     cohorts produce ugly histograms with 1-2 stocks per bin; the
 *     three-tick form gracefully degrades while keeping the same
 *     screen real-estate)
 *
 * All inputs come from `ScreenerColumnStats.sortedValues`, which already
 * excludes sig-gated cells (see `buildCohortStats`). The strip therefore
 * shows what the cohort actually *contributes* to ranking, not the
 * unfiltered raw distribution.
 */
import type { ScreenerColumnStats } from "./types";

export const MIN_HISTOGRAM_N = 20;
export const DEFAULT_HISTOGRAM_BINS = 18;

export interface HistogramBin {
  /** Inclusive lower bound. */
  x0: number;
  /** Exclusive upper bound (inclusive on the last bin). */
  x1: number;
  count: number;
}

/**
 * Build equal-width bins from a sorted ascending values list. Returns an
 * empty array for empty input. When all values collapse to a single point
 * (max == min), returns a single bin containing every value — the strip
 * renderer handles this as a vertical line at center.
 */
export function buildHistogramBins(
  sortedValues: ReadonlyArray<number>,
  binCount: number = DEFAULT_HISTOGRAM_BINS,
): HistogramBin[] {
  const n = sortedValues.length;
  if (n === 0) return [];
  const min = sortedValues[0]!;
  const max = sortedValues[n - 1]!;
  if (max <= min) {
    return [{ x0: min, x1: max, count: n }];
  }
  const safeBinCount = Math.max(1, Math.floor(binCount));
  const step = (max - min) / safeBinCount;
  const bins: HistogramBin[] = [];
  for (let i = 0; i < safeBinCount; i++) {
    bins.push({ x0: min + i * step, x1: min + (i + 1) * step, count: 0 });
  }
  for (const v of sortedValues) {
    let idx = Math.floor((v - min) / step);
    if (idx >= safeBinCount) idx = safeBinCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]!.count++;
  }
  return bins;
}

/**
 * Map a value `v` to its horizontal position (0..1) within a cohort's
 * [min, max] range. Clamped to [0, 1] so out-of-range values (e.g., a
 * sig-gated value still being hovered) sit at the strip's edge rather
 * than off-strip.
 *
 * Returns null when the value is non-finite or stats are unavailable.
 * When the cohort is degenerate (max == min), returns 0.5 so the tick
 * lands at the center of the strip.
 */
export function valuePositionInCohort(
  value: number | null,
  stats: ScreenerColumnStats | null,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!stats || stats.n === 0) return null;
  const range = stats.max - stats.min;
  if (range <= 0) return 0.5;
  const t = (value - stats.min) / range;
  return Math.max(0, Math.min(1, t));
}

/**
 * Three-tick fallback values (min, median, max) for cohorts below
 * MIN_HISTOGRAM_N. Returns null when the cohort is empty.
 */
export interface ThreeTick {
  min: number;
  median: number;
  max: number;
}

export function threeTickFromStats(
  stats: ScreenerColumnStats | null,
): ThreeTick | null {
  if (!stats || stats.n === 0) return null;
  const sorted = stats.sortedValues;
  const n = sorted.length;
  // Median: lower-median for even n (matches percentile computePctRank's
  // average-rank convention without the half-rank adjustment).
  const median =
    n % 2 === 0
      ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
      : sorted[(n - 1) / 2]!;
  return { min: stats.min, median, max: stats.max };
}

/** Decide which display mode the strip should use for a given cohort. */
export function histogramMode(
  stats: ScreenerColumnStats | null,
): "histogram" | "threeTick" | "empty" {
  if (!stats || stats.n === 0) return "empty";
  if (stats.n < MIN_HISTOGRAM_N) return "threeTick";
  return "histogram";
}
