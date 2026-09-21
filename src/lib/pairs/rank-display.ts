/**
 * Pairs tab — pure display-layer helpers for the ranked pair table. No I/O.
 *
 * `capByLeg` stops the rank list telling one story many times (e.g. "analysts
 * are cutting airlines" filling the top slots): a single leg key may appear at
 * most `cap` times across the SHOWN list, counting either side. Nothing is
 * dropped from the data — the overflow rows are returned separately so the UI
 * can collapse them behind an indicator and still export the full set.
 */

export interface LegPair {
  longKey: string;
  shortKey: string;
}

export interface CapByLegResult<T extends LegPair> {
  /** Rows kept in list order, respecting the per-leg cap. */
  shown: T[];
  /** Rows collapsed because one of their legs was already at the cap. */
  hidden: T[];
  /** How many rows each leg key pushed into the overflow (for the indicator). */
  hiddenByLeg: Map<string, number>;
}

/**
 * Keep a row only while neither of its legs has already been shown `cap` times.
 * A non-positive cap disables capping (everything is shown).
 */
export function capByLeg<T extends LegPair>(rows: T[], cap: number): CapByLegResult<T> {
  if (!Number.isFinite(cap) || cap <= 0) {
    return { shown: [...rows], hidden: [], hiddenByLeg: new Map() };
  }
  const counts = new Map<string, number>();
  const shown: T[] = [];
  const hidden: T[] = [];
  const hiddenByLeg = new Map<string, number>();
  const at = (k: string) => (counts.get(k) ?? 0) >= cap;

  for (const r of rows) {
    if (at(r.longKey) || at(r.shortKey)) {
      hidden.push(r);
      // Attribute the overflow to the leg that hit the cap (long leg first).
      const blame = at(r.longKey) ? r.longKey : r.shortKey;
      hiddenByLeg.set(blame, (hiddenByLeg.get(blame) ?? 0) + 1);
      continue;
    }
    shown.push(r);
    counts.set(r.longKey, (counts.get(r.longKey) ?? 0) + 1);
    counts.set(r.shortKey, (counts.get(r.shortKey) ?? 0) + 1);
  }
  return { shown, hidden, hiddenByLeg };
}
