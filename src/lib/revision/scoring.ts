/**
 * Engine 1 — pure scoring math: winsorize, peer-relative z-score, equal-weight
 * composite, decile cut, and week-over-week new-arrival detection. No I/O.
 */

/** Winsorize a set of finite numbers to the [p, 1-p] quantiles (in place-safe copy). */
export function winsorize(values: number[], p = 0.02): number[] {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return values.slice();
  const lo = finite[Math.floor(p * (finite.length - 1))]!;
  const hi = finite[Math.ceil((1 - p) * (finite.length - 1))]!;
  return values.map((v) => (!Number.isFinite(v) ? v : Math.min(hi, Math.max(lo, v))));
}

export interface ZResult {
  mean: number;
  std: number;
  z: Map<number, number>; // original index -> z-score (only for finite inputs)
}

/**
 * Peer-relative z-scores for the finite entries of `values` (indexed by their
 * position). Winsorizes first. Returns an empty z-map when std collapses.
 */
export function zScores(values: Array<number | null>, p = 0.02): ZResult {
  const idx: number[] = [];
  const raw: number[] = [];
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) {
      idx.push(i);
      raw.push(v);
    }
  });
  const z = new Map<number, number>();
  if (raw.length < 2) return { mean: raw[0] ?? 0, std: 0, z };
  const wins = winsorize(raw, p);
  const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
  const variance = wins.reduce((a, b) => a + (b - mean) ** 2, 0) / wins.length;
  const std = Math.sqrt(variance);
  if (std < 1e-12) return { mean, std: 0, z };
  idx.forEach((origIndex, k) => z.set(origIndex, (wins[k]! - mean) / std));
  return { mean, std, z };
}

/**
 * Equal-weighted composite across the provided z-score maps. Each entry is the
 * mean of that index's available z-scores; indices with no z-scores get null.
 * `weights` (optional) lets the Leg-B backtest tune the per-signal blend.
 */
export function compositeScores(
  zMaps: Array<{ key: string; z: Map<number, number> }>,
  count: number,
  weights?: Record<string, number>,
): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    let wsum = 0;
    for (const { key, z } of zMaps) {
      const v = z.get(i);
      if (v === undefined) continue;
      const w = weights?.[key] ?? 1;
      sum += v * w;
      wsum += w;
    }
    out.push(wsum > 0 ? sum / wsum : null);
  }
  return out;
}

export interface RankedEntry {
  index: number;
  composite: number;
  rank: number; // 1 = strongest
  decile: number; // 1..10, 10 = strongest
}

/** Rank by composite descending and cut into deciles (10 = strongest). */
export function rankAndDecile(composites: Array<number | null>): RankedEntry[] {
  const scored = composites
    .map((composite, index) => ({ index, composite }))
    .filter((e): e is { index: number; composite: number } => e.composite !== null && Number.isFinite(e.composite));
  scored.sort((a, b) => b.composite - a.composite);
  const n = scored.length;
  return scored.map((e, i) => ({
    index: e.index,
    composite: e.composite,
    rank: i + 1,
    decile: n <= 1 ? 10 : Math.min(10, Math.floor(((n - 1 - i) / (n - 1)) * 10) + 1),
  }));
}

/**
 * New arrival = entered the top `topDecile` this week from below it (or absent)
 * last week. This is the change-detector flag: surfaces freshly-inflecting names.
 */
export function isNewArrival(
  currentDecile: number | null,
  priorDecile: number | null,
  topDecile = 9,
): boolean {
  if (currentDecile === null || currentDecile < topDecile) return false;
  return priorDecile === null || priorDecile < topDecile;
}
