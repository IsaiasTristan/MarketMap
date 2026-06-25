/**
 * rank-factor-movers — pure ranking of a factor's per-stock return
 * contributions into top-N most-positive and top-N most-negative lists.
 *
 * The caller computes each stock's contribution value (β × factor return,
 * live or cached) and passes the entries in; this helper only sorts, splits,
 * and reports the heat range. Pure (no I/O) so the contract is unit-tested.
 */
import type { FactorTopMoverEntry } from "@/types/factors";

export interface TopMoversSplit {
  /** Most-positive contributions first (descending), capped at the limit. */
  positive: FactorTopMoverEntry[];
  /** Most-negative contributions first (ascending), capped at the limit. */
  negative: FactorTopMoverEntry[];
  /** Min/max over all finite contributions — used to scale the heat cells. */
  range: { min: number; max: number };
}

/**
 * Split factor contribution entries into top-`limit` positive and negative
 * lists. Non-finite values are dropped from both lists and the range.
 */
export function splitTopMovers(
  entries: FactorTopMoverEntry[],
  limit = 20,
): TopMoversSplit {
  const finite = entries.filter((e) => Number.isFinite(e.value));

  const positive = [...finite]
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);

  const negative = [...finite]
    .filter((e) => e.value < 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, limit);

  const vals = finite.map((e) => e.value);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;

  return { positive, negative, range: { min, max } };
}
