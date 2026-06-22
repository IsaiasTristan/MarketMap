/**
 * Sectors hidden from the Market Map page (main hierarchy grid + Top Movers).
 *
 * These tickers stay in the universe and remain available everywhere else
 * (the /factors tab, the factor pipeline, scenarios, etc.); they're only
 * excluded from the stock-ranking surfaces on the Performance page, where
 * index / macro instruments would otherwise dominate the gainers/losers
 * lists and clutter the sector hierarchy.
 *
 * Match is case-insensitive after trim so user-typed CSV casing variations
 * ("Index & Macro", "INDEX & MACRO", etc.) all resolve to the same bucket.
 */
export const MARKET_MAP_EXCLUDED_SECTORS: readonly string[] = [
  "INDEX & MACRO",
];

const EXCLUDED_SET = new Set(
  MARKET_MAP_EXCLUDED_SECTORS.map((s) => s.toUpperCase()),
);

export function isExcludedSector(sector?: string | null): boolean {
  if (!sector) return false;
  return EXCLUDED_SET.has(sector.trim().toUpperCase());
}
