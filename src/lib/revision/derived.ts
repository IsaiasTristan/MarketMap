/**
 * Engine 1 — pure derived-metric math on top of the weekly composite series:
 * clamped trailing means (the revision leg of the gap score), sign streaks
 * (with the Leg-A/Leg-B source switch), group/idiosyncratic decomposition, and
 * the epsDispersion trend. Every window CLAMPS to available history and
 * surfaces the effective window so sparse Leg-A depth degrades gracefully.
 * No I/O.
 */
import { zScores } from "@/lib/revision/scoring";
import { bucketBy, meanOrNull } from "@/lib/revision/aggregate";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";

export interface TrailingMeanResult {
  value: number | null;
  /** Finite observations actually used (<= window). */
  weeksUsed: number;
}

/**
 * Mean of the last `window` entries of `series` (oldest-first), clamped to
 * what exists and skipping nulls. Null value when nothing finite is in view.
 */
export function trailingMean(series: Array<number | null>, window: number): TrailingMeanResult {
  const tail = series.slice(Math.max(0, series.length - window));
  const finite = tail.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return { value: null, weeksUsed: 0 };
  return { value: finite.reduce((a, b) => a + b, 0) / finite.length, weeksUsed: finite.length };
}

export interface Streak {
  len: number;
  sign: -1 | 0 | 1;
}

/**
 * Consecutive same-sign run at the END of an oldest-first series. Zeros and
 * nulls break (and never start) a streak. Streaks are on the COMPOSITE sign —
 * a per-name statement — not breadth.
 */
export function computeStreak(seriesOldestFirst: Array<number | null>): Streak {
  let len = 0;
  let sign: -1 | 0 | 1 = 0;
  for (let i = seriesOldestFirst.length - 1; i >= 0; i--) {
    const v = seriesOldestFirst[i];
    if (v === null || v === undefined || !Number.isFinite(v) || v === 0) break;
    const s: -1 | 1 = v > 0 ? 1 : -1;
    if (len === 0) sign = s;
    else if (s !== sign) break;
    len++;
  }
  return { len, sign: len === 0 ? 0 : sign };
}

export type StreakSource = "LEG_A" | "LEG_B";

/**
 * Streaks read the Leg-B (ratings + price targets) reconstruction — which has
 * full backfilled history — until the Leg-A snapshot store is deep enough to
 * carry a meaningful run on its own.
 */
export function pickStreakSource(
  legADepthWeeks: number,
  minWeeks: number = REVISION_THRESHOLDS.legAStreakMinWeeks,
): StreakSource {
  return legADepthWeeks >= minWeeks ? "LEG_A" : "LEG_B";
}

export interface Decomposition {
  /** Per-name group component: the name's peer-group mean composite, re-z-scored across groups. */
  groupZ: Array<number | null>;
  /** Per-name idiosyncratic component: composite - groupZ. */
  idioZ: Array<number | null>;
  /** groupKey -> that group's re-z-scored mean (for aggregates / decomp rollups). */
  groupZByKey: Map<string, number>;
}

/**
 * Split each name's composite into "the group is moving" vs "this name is
 * moving within its group". Group mean composites are re-z-scored ACROSS
 * groups (same winsorize+z machinery as the signals) so groupZ is on the same
 * scale as the composite; idio is the simple residual.
 */
export function decomposeComposites(
  composites: Array<number | null>,
  groupKeys: string[],
): Decomposition {
  const items = composites.map((c, i) => ({ c, key: groupKeys[i] ?? "Unclassified" }));
  const buckets = bucketBy(items, (item) => item.key);
  const keys = [...buckets.keys()];
  const groupMeans = keys.map((k) => meanOrNull(buckets.get(k)!.map((i) => composites[i] ?? null)));
  const { z } = zScores(groupMeans);
  const groupZByKey = new Map<string, number>();
  keys.forEach((k, ki) => {
    const zv = z.get(ki);
    if (zv !== undefined) groupZByKey.set(k, zv);
  });
  const groupZ = composites.map((_, i) => groupZByKey.get(groupKeys[i] ?? "Unclassified") ?? null);
  const idioZ = composites.map((c, i) => {
    const g = groupZ[i];
    return c !== null && Number.isFinite(c) && g !== null ? c - g : null;
  });
  return { groupZ, idioZ, groupZByKey };
}

/** Least-squares slope of a series against its index; null under 2 finite points. */
export function lsSlope(series: Array<number | null>): number | null {
  const pts: Array<{ x: number; y: number }> = [];
  series.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) pts.push({ x: i, y: v });
  });
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den < 1e-12) return null;
  return num / den;
}

export type DispersionTrend = "NARROWING" | "WIDENING" | "FLAT";

/**
 * Sign of the trailing epsDispersion slope, with a flat band scaled to the
 * mean dispersion level. Null under 3 finite observations (Leg A accruing).
 */
export function dispersionTrend(
  seriesOldestFirst: Array<number | null>,
  window: number = REVISION_THRESHOLDS.dispersionTrendWindow,
  flatBand: number = REVISION_THRESHOLDS.dispersionFlatBand,
): DispersionTrend | null {
  const tail = seriesOldestFirst.slice(Math.max(0, seriesOldestFirst.length - window));
  const finite = tail.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length < 3) return null;
  const slope = lsSlope(tail);
  if (slope === null) return null;
  const level = Math.abs(finite.reduce((a, b) => a + b, 0) / finite.length);
  const band = level > 1e-12 ? level * flatBand : flatBand;
  if (Math.abs(slope) <= band) return "FLAT";
  return slope > 0 ? "WIDENING" : "NARROWING";
}
