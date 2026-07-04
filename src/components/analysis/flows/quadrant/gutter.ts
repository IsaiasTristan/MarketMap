/**
 * Below-range (gutter) classification for the crowding × conviction scatter.
 *
 * The y-axis is log with a floor (0.3% of book); names at or under that floor
 * — including null-conviction names — would otherwise clamp onto the single
 * axis-floor pixel row and pile into a hard gray stripe. Instead they are
 * pulled out of the plot body and laid out in a dedicated GUTTER band beneath
 * the axis. This module is the pure classifier; it never touches the frozen
 * data layer (buildQuadrantModel) — it only partitions points the model built.
 */

/**
 * A point is "below range" when its conviction is unknown (null) or strictly
 * below the gutter floor. The floor itself (== floorPct) is IN range so a name
 * sitting exactly on the visible axis floor still plots in the body.
 *
 * @param conviction  median % of book (the y value); null when unknown.
 * @param gutterFloorPct  floor in percent-of-book units (e.g. 0.3 for 0.3%).
 */
export function isBelowRange(conviction: number | null, gutterFloorPct: number): boolean {
  if (conviction === null) return true;
  return conviction < gutterFloorPct;
}

/**
 * Split points into those that plot in the body (`inRange`) and those that
 * belong in the gutter band (`belowRange`). The partition is total and
 * disjoint, and preserves input order within each side (deterministic).
 */
export function partitionGutter<T extends { conviction: number | null }>(
  pts: T[],
  gutterFloorPct: number,
): { inRange: T[]; belowRange: T[] } {
  const inRange: T[] = [];
  const belowRange: T[] = [];
  for (const p of pts) {
    (isBelowRange(p.conviction, gutterFloorPct) ? belowRange : inRange).push(p);
  }
  return { inRange, belowRange };
}
