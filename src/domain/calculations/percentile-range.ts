import type { Horizon } from "@/domain/entities/horizons";

/**
 * Linear-interpolated quantile of an ascending-sorted array. `q` is clamped to
 * [0, 1]. Empty input returns 0; a single element returns that element.
 */
export function quantileSorted(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! + frac * (sortedAsc[hi]! - sortedAsc[lo]!);
}

/**
 * Per-horizon winsorized display range for heat coloring. The lower/upper
 * tails (default 5% each) are clamped to the p5 / p95 quantiles so a handful
 * of extreme cells (e.g. a single -30% stock) don't inflate the heat span and
 * wash out the bulk of the grid. Values beyond the percentile simply clamp to
 * full saturation in the heat ramp.
 *
 * Returns the same `{ min, max }` shape as a plain min/max range so it is a
 * drop-in replacement; `heatmapRgb` derives the symmetric span from it.
 */
export function percentileColumnRanges(
  rows: { cells: Record<Horizon, number | null> }[],
  horizons: readonly Horizon[],
  tail = 0.05,
): { min: Record<string, number>; max: Record<string, number> } {
  const min: Record<string, number> = {};
  const max: Record<string, number> = {};
  for (const h of horizons) {
    const vals = rows
      .map((r) => r.cells[h])
      .filter((v): v is number => v != null && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vals.length === 0) {
      min[h] = 0;
      max[h] = 0;
    } else {
      min[h] = quantileSorted(vals, tail);
      max[h] = quantileSorted(vals, 1 - tail);
    }
  }
  return { min, max };
}
