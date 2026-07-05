/**
 * Security classification for the Flows rotation & leaderboard.
 *
 * Rotation groups by the user's canonical market-map taxonomy
 * (UniverseConstituent.sector / subTheme, mirrored onto RevisionReference). Two
 * kinds of names must not sit as ordinary sector rows:
 *
 *   - VEHICLES — index / sector / thematic / factor ETFs, treasuries, credit,
 *     and levered ETFs. These are instruments, not companies that funds
 *     "rotate" between, so they are excluded from every rotation view, from
 *     sector netflow, and from the leaderboard. (They may feed a future
 *     hedging/vehicles panel.)
 *   - UNCLASSIFIED — held names with no canonical sector (sub-$300M names
 *     outside the curated universe). Bucketed into a single "Unclassified" row,
 *     rendered last with a data-quality count — never silently dropped.
 *
 * Everything else is an EQUITY, grouped by its canonical sector. Mega-cap and
 * international-mega equities stay as their own canonical rows (per product
 * decision); size is handled as a separate view filter, not a class.
 *
 * Pure and dependency-free so it can be unit-tested and reused on read/write.
 */

export type SecurityClass = "equity" | "vehicle" | "unclassified";

/** The single catch-all bucket for held names lacking a canonical sector. */
export const UNCLASSIFIED_SECTOR = "Unclassified";

/** Canonical market-map sectors that are entirely instrument vehicles. */
const VEHICLE_SECTORS = new Set(["INDEX & MACRO"]);
/** Canonical sub-themes that are vehicles even inside an otherwise-equity sector. */
const VEHICLE_SUBTHEMES = new Set(["LEVERED ETFS"]);
/** Duplicate/legacy FMP sector strings folded into their canonical market-map name. */
const SECTOR_ALIASES = new Map<string, string>([["FINANCIAL SERVICES", "Financials"]]);

/**
 * Near-synonym sub-theme labels folded to one canonical label (Part 2 label
 * hygiene), so the subsector board doesn't split one theme across two rows.
 * Keyed by the UPPER-cased raw label. Add pairs here as they surface; the value
 * is the canonical label shown on the board. NOTE: these MUST be genuine synonyms
 * within a single parent sector — never use this to merge two real subsectors.
 */
const SUBSECTOR_ALIASES = new Map<string, string>([
  ["MINERALS", "Miners"], // user taxonomy uses both "Miners" and "Minerals" for the same theme
]);

const norm = (s: string | null | undefined): string => (s ?? "").trim().toUpperCase();

/** Canonicalize a sub-theme label: trim, then fold known synonyms. Null-safe. */
export function canonicalSubsector(subTheme: string | null): string | null {
  const t = subTheme?.trim();
  if (!t) return null;
  return SUBSECTOR_ALIASES.get(t.toUpperCase()) ?? t;
}

export interface Classified {
  securityClass: SecurityClass;
  /** Sector to GROUP rotation by: canonical sector, "Unclassified", or null for
   *  vehicles (excluded from all sector rollups). */
  groupSector: string | null;
  /** Subsector to group by; null for vehicles and unclassified names. */
  groupSubsector: string | null;
}

/**
 * Classify a held name from its canonical (market-map) sector and sub-theme.
 * `sector` / `subTheme` are the RevisionReference canonical strings (null when
 * the name is outside the curated universe).
 */
export function classifySecurity(sector: string | null, subTheme: string | null): Classified {
  if (VEHICLE_SECTORS.has(norm(sector)) || VEHICLE_SUBTHEMES.has(norm(subTheme))) {
    return { securityClass: "vehicle", groupSector: null, groupSubsector: null };
  }
  if (!sector || !sector.trim()) {
    return { securityClass: "unclassified", groupSector: UNCLASSIFIED_SECTOR, groupSubsector: null };
  }
  const canonical = SECTOR_ALIASES.get(norm(sector)) ?? sector.trim();
  return {
    securityClass: "equity",
    groupSector: canonical,
    groupSubsector: canonicalSubsector(subTheme),
  };
}

/** True for names excluded from all rotation views, sector netflow, and the leaderboard. */
export function isVehicleClass(securityClass: string | null | undefined): boolean {
  return securityClass === "vehicle";
}
