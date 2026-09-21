/**
 * Beta shrinkage for the Hedge Finder.
 *
 * Small-cap single-name betas from a 252-day regression are noisy; a candidate
 * short chosen purely on its point estimate over-fits sampling error. We shrink
 * each name's factor-beta vector toward its subsector mean (a James-Stein style
 * regularizer) at a fixed intensity λ (default `betaShrinkLambda` = 0.3) so the
 * optimiser hedges the stable, group-shared component of exposure rather than
 * one name's estimation noise. Pure, no I/O.
 */

/** Equal-weight mean of a set of equal-length vectors. Empty input → []. */
export function meanVector(vectors: number[][]): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  const k = vectors[0]!.length;
  const out = new Array<number>(k).fill(0);
  for (const v of vectors) {
    for (let j = 0; j < k; j++) out[j]! += (v[j] ?? 0) / n;
  }
  return out;
}

/** β_shrunk = (1 − λ) · β + λ · target, element-wise. λ clamped to [0, 1]. */
export function shrinkToward(beta: number[], target: number[], lambda: number): number[] {
  const l = Math.min(1, Math.max(0, lambda));
  return beta.map((b, j) => (1 - l) * b + l * (target[j] ?? 0));
}

/**
 * Shrink every entry's beta vector toward the mean beta of its group.
 * A group of one shrinks toward itself (no change). Returns a map keyed by
 * the entry `key` so callers can look up the regularized vector by ticker.
 */
export function shrinkBetasByGroup(
  entries: { key: string; group: string; beta: number[] }[],
  lambda: number,
): Map<string, number[]> {
  const byGroup = new Map<string, number[][]>();
  for (const e of entries) {
    const arr = byGroup.get(e.group);
    if (arr) arr.push(e.beta);
    else byGroup.set(e.group, [e.beta]);
  }
  const groupMean = new Map<string, number[]>();
  for (const [g, vecs] of byGroup) groupMean.set(g, meanVector(vecs));

  const out = new Map<string, number[]>();
  for (const e of entries) {
    const target = groupMean.get(e.group) ?? e.beta;
    out.set(e.key, shrinkToward(e.beta, target, lambda));
  }
  return out;
}
