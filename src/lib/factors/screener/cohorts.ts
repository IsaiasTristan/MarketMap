/**
 * Cohort partitioning for the per-stock screener.
 *
 * The reference group from the toolbar — Universe / Sector / Sub-theme /
 * Custom peer set — defines the cohort against which percentiles, z-scores,
 * and conditional-formatting heat are computed.
 *
 * Tiny-cohort fallback: when a row's natural cohort has fewer than
 * `MIN_COHORT_SIZE` peers (default 5), we silently widen ONE level —
 * sub-theme → sector → universe — and record the (from, to) so tooltips
 * can name the actual reference group used. Two stocks that look like
 * they're being ranked against the same cohort might differ; the widening
 * trace surfaces that.
 */
import type { PerStockRow } from "@/server/services/factor-per-stock.service";
import type { FactorScreenerRefGroup } from "@/store/analysis";
import type { ScreenerCohorts } from "./types";

/** Minimum cohort size below which we widen one level. */
export const MIN_COHORT_SIZE = 5;

const UNIVERSE_KEY = "universe";

/** Build "kind:label" cohort key (escapes nothing — labels are arbitrary text). */
function partitionKey(kind: string, label: string): string {
  return `${kind}:${label}`;
}

/**
 * Assign every row to a cohort key under the requested ref group, widening
 * one level when the natural cohort is below `MIN_COHORT_SIZE`.
 *
 * Custom peer sets are accepted in the type signature but treated as
 * universe partitioning when no `customMembers` are provided — the peer-set
 * UI is deferred to a later phase.
 */
export function assignCohorts(
  rows: ReadonlyArray<PerStockRow>,
  refGroup: FactorScreenerRefGroup,
  options: { customMembers?: ReadonlyArray<string> } = {},
): ScreenerCohorts {
  const keyByTicker = new Map<string, string>();
  const widenedFromTo = new Map<string, { from: string; to: string }>();
  const sizeByKey = new Map<string, number>();

  // Pre-compute partition counts for sub-theme + sector so we can cheaply
  // decide whether the natural cohort is too small.
  const subThemeCounts = new Map<string, number>();
  const sectorCounts = new Map<string, number>();
  for (const row of rows) {
    const stKey = partitionKey("subTheme", row.subTheme);
    const sKey = partitionKey("sector", row.sector);
    subThemeCounts.set(stKey, (subThemeCounts.get(stKey) ?? 0) + 1);
    sectorCounts.set(sKey, (sectorCounts.get(sKey) ?? 0) + 1);
  }

  for (const row of rows) {
    const stKey = partitionKey("subTheme", row.subTheme);
    const sKey = partitionKey("sector", row.sector);

    let chosen: string;
    let from: string | null = null;
    let to: string | null = null;

    if (refGroup.kind === "universe") {
      chosen = UNIVERSE_KEY;
    } else if (refGroup.kind === "sector") {
      const count = sectorCounts.get(sKey) ?? 0;
      if (count < MIN_COHORT_SIZE) {
        from = sKey;
        chosen = UNIVERSE_KEY;
        to = UNIVERSE_KEY;
      } else {
        chosen = sKey;
      }
    } else if (refGroup.kind === "subTheme") {
      const stCount = subThemeCounts.get(stKey) ?? 0;
      if (stCount >= MIN_COHORT_SIZE) {
        chosen = stKey;
      } else {
        // Walk one level up — sector first.
        const sCount = sectorCounts.get(sKey) ?? 0;
        from = stKey;
        if (sCount >= MIN_COHORT_SIZE) {
          chosen = sKey;
          to = sKey;
        } else {
          chosen = UNIVERSE_KEY;
          to = UNIVERSE_KEY;
        }
      }
    } else {
      // Custom peer sets — deferred. When member list provided, partition by
      // membership: ticker is in set → custom key, otherwise → universe so the
      // grid still ranks the rest of the universe sensibly.
      const members = options.customMembers
        ? new Set(options.customMembers.map((t) => t.toUpperCase()))
        : null;
      if (members && members.has(row.ticker.toUpperCase())) {
        chosen = `custom:${refGroup.customId ?? "default"}`;
      } else {
        chosen = UNIVERSE_KEY;
      }
    }

    keyByTicker.set(row.ticker, chosen);
    if (from && to && from !== to) {
      widenedFromTo.set(row.ticker, { from, to });
    }
    sizeByKey.set(chosen, (sizeByKey.get(chosen) ?? 0) + 1);
  }

  return { keyByTicker, widenedFromTo, sizeByKey };
}

/**
 * Human-readable cohort label for the tooltip — turns a cohort key like
 * "subTheme:AI Infrastructure" into "Sub-theme · AI Infrastructure".
 */
export function describeCohortKey(key: string): string {
  if (key === UNIVERSE_KEY) return "Universe";
  const colon = key.indexOf(":");
  if (colon < 0) return key;
  const kind = key.slice(0, colon);
  const label = key.slice(colon + 1);
  if (kind === "sector") return `Sector · ${label}`;
  if (kind === "subTheme") return `Sub-theme · ${label}`;
  if (kind === "custom") return `Peer set · ${label}`;
  return label;
}
