/**
 * Sort utilities for the per-stock screener.
 *
 * Conventions (locked):
 *   • NaN / null / non-finite sort keys always sort to BOTTOM, regardless of
 *     direction. A user clicking "sort desc by Score" sees real scores up
 *     top and missing scores at the end — same for "sort asc". Otherwise
 *     missing values flicker positions when a metric recomputes.
 *   • Ticker alphabetical is the FINAL tiebreaker, ascending — matches
 *     standard financial-grid behaviour and makes the visual order stable
 *     when many rows tie (e.g. sort by R² when most stocks are clustered).
 */

export type SortDirection = "asc" | "desc";

/**
 * Compare two rows on a single numeric key. `keyA` and `keyB` are the
 * pre-extracted sort keys for the two rows; pass `null` (or NaN) to mean
 * "this row has no value for the active sort column → push to bottom."
 *
 * Returns the standard < 0 / > 0 / 0 contract for Array.sort, with `dir`
 * applied AFTER the missing-to-bottom logic.
 */
export function compareSortKeys(
  keyA: number | null,
  keyB: number | null,
  dir: SortDirection,
): number {
  const naA = keyA === null || !Number.isFinite(keyA);
  const naB = keyB === null || !Number.isFinite(keyB);
  if (naA && naB) return 0;
  if (naA) return 1; // a missing → a sorts to bottom
  if (naB) return -1;
  // Both finite. Direction:
  if (keyA === keyB) return 0;
  return dir === "desc" ? (keyB as number) - (keyA as number) : (keyA as number) - (keyB as number);
}

/**
 * Final tiebreaker — ticker ascending, locale-aware, regardless of sort
 * direction. Returns -1/0/+1.
 */
export function tiebreakByTicker(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Compose a complete row comparator: primary key, then ticker tiebreak.
 * Use this from the grid: `rows.sort((a, b) => makeRowComparator(...)(a, b))`.
 */
export function makeRowComparator<Row>(
  extractKey: (row: Row) => number | null,
  extractTicker: (row: Row) => string,
  dir: SortDirection,
): (a: Row, b: Row) => number {
  return (a, b) => {
    const cmp = compareSortKeys(extractKey(a), extractKey(b), dir);
    if (cmp !== 0) return cmp;
    return tiebreakByTicker(extractTicker(a), extractTicker(b));
  };
}
