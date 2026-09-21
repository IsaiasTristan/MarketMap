/**
 * Pairs tab — Engine 2 (business-inflection) breadth classification. No I/O.
 *
 * A name is classified inflecting-up / deteriorating from the SIX RAW
 * inflection components (margin/EBITDA-margin inflection, revenue-growth
 * acceleration, FCF inflection, ROIC trend, deleveraging) — NEVER from the peer
 * box z-scores, which are mean-zero within subsector and so cannot be compared
 * across groups (brief §3). The components have different units (slopes of
 * different metrics), so we vote on their SIGNS rather than averaging levels:
 * scale-free, and in the same "count how many are improving" spirit as breadth.
 */
import type { InflectionSignals } from "@/lib/fundamental/inflection";
import type { BreadthDirection } from "@/lib/pairs/breadth";

/** The six oriented (higher = better) inflection components, in registry order. */
const COMPONENTS: Array<keyof InflectionSignals> = [
  "grossMarginInflection",
  "ebitdaMarginInflection",
  "revenueGrowthAccel",
  "fcfInflection",
  "roicTrend",
  "deleveraging",
];

export interface E2DirectionResult {
  direction: BreadthDirection;
  positive: number;
  negative: number;
  available: number;
}

/**
 * Direction = sign of (positive-component votes - negative-component votes)
 * across the finite components. Requires at least `minComponents` finite
 * components, else the name is unclassifiable (dropped from breadth, not flat).
 */
export function e2Direction(signals: InflectionSignals, minComponents = 3): E2DirectionResult | null {
  let pos = 0;
  let neg = 0;
  let avail = 0;
  for (const k of COMPONENTS) {
    const v = signals[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    avail++;
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  if (avail < minComponents) return null;
  const direction: BreadthDirection = pos > neg ? 1 : neg > pos ? -1 : 0;
  return { direction, positive: pos, negative: neg, available: avail };
}
