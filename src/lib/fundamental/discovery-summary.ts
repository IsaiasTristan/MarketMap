/**
 * Pure roll-up of discovery rows by sector → subsector for the summary block
 * above the Discovery Rank table.
 */

export const DISCOVERY_SIGNAL_KEYS = [
  "grossMarginInflection",
  "ebitdaMarginInflection",
  "revenueGrowthAccel",
  "fcfInflection",
  "roicTrend",
  "deleveraging",
] as const;

export type DiscoverySignalKey = (typeof DISCOVERY_SIGNAL_KEYS)[number];

export interface DiscoverySummaryInput {
  sector: string | null;
  subsector: string | null;
  composite: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  cheapness: number | null;
  z: Partial<Record<DiscoverySignalKey, number | null>>;
}

export interface DiscoveryGroupSummary {
  key: string;
  nameCount: number;
  avgComposite: number | null;
  avgDecile: number | null;
  avgSignals: Record<DiscoverySignalKey, number | null>;
  avgVal: number | null;
}

export interface DiscoverySectorSummary extends DiscoveryGroupSummary {
  subsectors: DiscoveryGroupSummary[];
}

function meanFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function summarizeGroup(
  key: string,
  rows: DiscoverySummaryInput[],
): DiscoveryGroupSummary {
  const avgSignals = Object.fromEntries(
    DISCOVERY_SIGNAL_KEYS.map((sig) => [sig, meanFinite(rows.map((r) => r.z[sig] ?? null))]),
  ) as Record<DiscoverySignalKey, number | null>;

  return {
    key,
    nameCount: rows.length,
    avgComposite: meanFinite(rows.map((r) => r.composite)),
    avgDecile: meanFinite(rows.map((r) => r.subsectorDecile ?? r.sectorDecile)),
    avgSignals,
    avgVal: meanFinite(rows.map((r) => r.cheapness)),
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Sector → subsector roll-up with per-column averages. */
export function buildDiscoverySummary(rows: DiscoverySummaryInput[]): DiscoverySectorSummary[] {
  const bySector = groupBy(rows, (r) => r.sector?.trim() || "Unclassified");

  const sectors: DiscoverySectorSummary[] = [];
  for (const [sectorKey, sectorRows] of bySector) {
    const bySub = groupBy(sectorRows, (r) => r.subsector?.trim() || sectorKey);
    const subsectors = [...bySub.entries()]
      .map(([subKey, subRows]) => summarizeGroup(subKey, subRows))
      .sort((a, b) => (b.avgComposite ?? -Infinity) - (a.avgComposite ?? -Infinity));

    sectors.push({
      ...summarizeGroup(sectorKey, sectorRows),
      subsectors,
    });
  }

  sectors.sort((a, b) => (b.avgComposite ?? -Infinity) - (a.avgComposite ?? -Infinity));
  return sectors;
}
