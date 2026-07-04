/**
 * Interpretation-zone taxonomy for the crowding × conviction scatter — the 2×2
 * grid around the rolling p75 breadth/conviction boundaries. Shared by the
 * region inspector (Part 2) and the zone census strip (Part 4) so both read the
 * same definitions. Pure — no React/DOM.
 */

export type Zone = "emerging" | "crowded" | "toe-dipping" | "below-median";

/** Display order for the census strip, left→right. */
export const ZONE_ORDER: readonly Zone[] = ["emerging", "crowded", "toe-dipping", "below-median"] as const;

export const ZONE_LABEL: Record<Zone, string> = {
  emerging: "emerging conviction",
  crowded: "crowded — unwind risk",
  "toe-dipping": "toe-dipping",
  "below-median": "below median conviction",
};

/**
 * Which zone a point sits in, relative to the p75 boundaries:
 * - high conviction + low breadth  → emerging conviction (the edge)
 * - high conviction + high breadth → crowded
 * - low conviction  + low breadth  → toe-dipping
 * - low conviction  + high breadth → below median conviction (broad, low conviction)
 * Null/zero conviction counts as low. Boundary (== p75) counts as the low side.
 */
export function classifyZone(breadth: number, conviction: number | null, p75Breadth: number, p75Conviction: number): Zone {
  const highConviction = (conviction ?? 0) > p75Conviction;
  const highBreadth = breadth > p75Breadth;
  if (highConviction) return highBreadth ? "crowded" : "emerging";
  return highBreadth ? "below-median" : "toe-dipping";
}
