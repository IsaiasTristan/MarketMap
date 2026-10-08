/**
 * Engine 1 — pure math behind the materialized screen row and the weekly
 * universe strip. Everything here operates on an already-computed rank series
 * (`ptRevOrthZ`) plus this week's decile assignment; no I/O, no signal
 * definition. The service layer supplies the numbers, this decides what the
 * three screens get to display.
 */

/** Bins of the universe score distribution shown on Screen 1. */
export const HISTOGRAM_BINS = 41;
export const HISTOGRAM_MIN = -4;
export const HISTOGRAM_MAX = 4;
/** A subsector needs this many names before its breadth cell is meaningful. */
export const MIN_BREADTH_NAMES = 8;

/**
 * Consecutive weeks (ending this week) the name sat in `target`'s decile.
 * `decileHist` is oldest-first and must end on the current week. Returns 0
 * when this week is not at the target.
 */
export function consecutiveAtDecile(decileHist: Array<number | null>, target: number): number {
  let n = 0;
  for (let i = decileHist.length - 1; i >= 0; i--) {
    if (decileHist[i] !== target) break;
    n++;
  }
  return n;
}

/**
 * Counts of `values` per bin over [HISTOGRAM_MIN, HISTOGRAM_MAX]; out-of-range
 * values clamp into the end bins (the tails are the point of the chart).
 */
export function zHistogram(
  values: Array<number | null>,
  bins = HISTOGRAM_BINS,
  min = HISTOGRAM_MIN,
  max = HISTOGRAM_MAX,
): number[] {
  const out = new Array<number>(bins).fill(0);
  const width = (max - min) / bins;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    const idx = Math.floor((v - min) / width);
    out[Math.min(bins - 1, Math.max(0, idx))]!++;
  }
  return out;
}

export interface SubsectorBreadthCell {
  name: string;
  /** Cross-subsector z of this subsector's mean rank. */
  z: number;
  /** Change in that z vs 4 grid weeks ago; null when the prior week is absent. */
  chg4w: number | null;
  n: number;
}

/** Mean of a subsector's ranks, keyed by subsector, for buckets with n >= min. */
export function subsectorMeans(
  rows: Array<{ subsector: string; value: number | null }>,
  minNames = MIN_BREADTH_NAMES,
): Map<string, { mean: number; n: number }> {
  const buckets = new Map<string, number[]>();
  for (const r of rows) {
    if (r.value === null || !Number.isFinite(r.value)) continue;
    const arr = buckets.get(r.subsector);
    if (arr) arr.push(r.value);
    else buckets.set(r.subsector, [r.value]);
  }
  const out = new Map<string, { mean: number; n: number }>();
  for (const [k, vals] of buckets) {
    if (vals.length < minNames) continue;
    out.set(k, { mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length });
  }
  return out;
}

/**
 * Cross-subsector z of each subsector's mean rank, plus the 4-week change in
 * that z. Standardizing ACROSS subsectors is what makes the heatmap readable:
 * the peer z inside each bucket is ~zero-mean by construction, so the group
 * signal only exists on the universe scale.
 */
export function subsectorBreadth(
  current: Map<string, { mean: number; n: number }>,
  prior4w: Map<string, { mean: number; n: number }> | null,
): SubsectorBreadthCell[] {
  const zOf = (m: Map<string, { mean: number; n: number }>) => {
    const keys = [...m.keys()];
    const means = keys.map((k) => m.get(k)!.mean);
    if (means.length < 2) return new Map(keys.map((k) => [k, 0]));
    const mu = means.reduce((a, b) => a + b, 0) / means.length;
    const sd = Math.sqrt(means.reduce((s, v) => s + (v - mu) ** 2, 0) / (means.length - 1));
    return new Map(keys.map((k, i) => [k, sd > 1e-12 ? (means[i]! - mu) / sd : 0]));
  };
  const zNow = zOf(current);
  const zPrior = prior4w ? zOf(prior4w) : null;
  return [...current.entries()]
    .map(([name, { n }]) => {
      const z = zNow.get(name) ?? 0;
      const p = zPrior?.get(name);
      return { name, z, chg4w: p === undefined ? null : z - p, n };
    })
    .sort((a, b) => b.z - a.z);
}

export interface DecileChurn {
  arrivals: string[];
  exits: string[];
}

/** Who entered and who left a decile between two weeks (sorted, deterministic). */
export function decileChurn(prior: Set<string>, current: Set<string>): DecileChurn {
  const arrivals = [...current].filter((t) => !prior.has(t)).sort();
  const exits = [...prior].filter((t) => !current.has(t)).sort();
  return { arrivals, exits };
}

/**
 * Like-for-like consensus change over `weeks` grid steps: compare the SAME
 * fiscal period in both snapshots, so a fiscal-year roll (the forward period
 * flipping from FY26 to FY27) can never masquerade as a revision. Null when
 * the base is non-positive — a ratio off a loss-making base is not a percent.
 */
export function likeForLikeChange(
  currentAvg: number | null,
  currentFiscalDate: string | null,
  priorPeriodAvgs: Map<string, number | null> | null,
): number | null {
  if (currentAvg === null || !Number.isFinite(currentAvg)) return null;
  if (!currentFiscalDate || !priorPeriodAvgs) return null;
  const base = priorPeriodAvgs.get(currentFiscalDate) ?? null;
  if (base === null || !Number.isFinite(base) || base <= 0) return null;
  return currentAvg / base - 1;
}
