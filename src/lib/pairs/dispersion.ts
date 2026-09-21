/**
 * Pairs tab — within-group revision dispersion (brief §8.4). No I/O.
 *
 * CRITICAL: dispersion is measured on RAW winsorized revision values, NEVER on
 * the within-subsector z-scores. Those have unit variance by construction, so
 * every subsector would land at the same dispersion and the map would collapse
 * to a vertical line. Interquartile range is the measure; its own 5-year
 * percentile gives the x-position. Left = analysts treat the group alike (trade
 * the basket, Tier 1); right = analysts are separating winners from losers
 * (pair stocks inside it, Tier 2).
 */

function winsorize(values: number[], p = 0.05): number[] {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return [];
  const lo = finite[Math.floor(p * (finite.length - 1))]!;
  const hi = finite[Math.ceil((1 - p) * (finite.length - 1))]!;
  return finite.map((v) => Math.min(hi, Math.max(lo, v)));
}

/** Linear-interpolated quantile of a sorted array (q in [0,1]). */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Interquartile range (Q3 − Q1) of raw winsorized revision values. Null with
 * fewer than 4 finite values (a quartile of 3 points is noise).
 */
export function dispersionIqr(rawRevisionValues: Array<number | null>): number | null {
  const finite = rawRevisionValues.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length < 4) return null;
  const w = winsorize(finite).sort((a, b) => a - b);
  return quantileSorted(w, 0.75) - quantileSorted(w, 0.25);
}

/**
 * Percentile (0-100) of the latest IQR within the group's own IQR history
 * (inclusive of the latest point). Null with fewer than 8 historical points —
 * a shallow window can't place a percentile honestly.
 */
export function dispersionPercentile(iqrHistory: Array<number | null>): number | null {
  const finite = iqrHistory.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length < 8) return null;
  const last = finite[finite.length - 1]!;
  const below = finite.filter((v) => v <= last).length;
  return (100 * (below - 0.5)) / finite.length; // Hazen plotting position
}
