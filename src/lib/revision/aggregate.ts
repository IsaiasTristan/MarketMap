/**
 * Engine 1 — peer-group resolution (subsector-first with a sector fallback for
 * thin populations) and group rollups for the rotation / breadth views. Pure.
 */
import type { RevisionGroupType } from "@prisma/client";

export const MIN_PEERS = 8;

export interface RefClassification {
  ticker: string;
  sector: string | null;
  subsector: string | null;
}

export interface PeerGroup {
  peerGroupType: RevisionGroupType;
  peerGroupKey: string;
}

const UNCLASSIFIED = "Unclassified";

/**
 * Assign each ticker a peer group: its subsector when that subsector has at
 * least MIN_PEERS names in the universe, otherwise its sector. Tickers with no
 * classification fall into a sector-level "Unclassified" bucket.
 */
export function resolvePeerGroups(refs: RefClassification[]): Map<string, PeerGroup> {
  const subsectorCounts = new Map<string, number>();
  for (const r of refs) {
    if (r.subsector) subsectorCounts.set(r.subsector, (subsectorCounts.get(r.subsector) ?? 0) + 1);
  }
  const out = new Map<string, PeerGroup>();
  for (const r of refs) {
    if (r.subsector && (subsectorCounts.get(r.subsector) ?? 0) >= MIN_PEERS) {
      out.set(r.ticker, { peerGroupType: "SUBSECTOR", peerGroupKey: r.subsector });
    } else {
      out.set(r.ticker, { peerGroupType: "SECTOR", peerGroupKey: r.sector ?? UNCLASSIFIED });
    }
  }
  return out;
}

/** Bucket item indices by a string key. */
export function bucketBy<T>(items: T[], keyOf: (item: T) => string): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = keyOf(item);
    const arr = buckets.get(key);
    if (arr) arr.push(i);
    else buckets.set(key, [i]);
  });
  return buckets;
}

export interface GroupRollup {
  groupKey: string;
  nameCount: number;
  breadth: number | null; // mean of a per-stock breadth-like signal
  compositeMean: number | null;
}

/** Mean of finite values, or null. */
export function meanOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** Roll up per-stock breadth + composite into group aggregates keyed by `groupKeyOf`. */
export function rollupGroups<T>(
  items: T[],
  groupKeyOf: (item: T) => string,
  breadthOf: (item: T) => number | null,
  compositeOf: (item: T) => number | null,
): GroupRollup[] {
  const buckets = bucketBy(items, groupKeyOf);
  const out: GroupRollup[] = [];
  for (const [groupKey, idxs] of buckets) {
    out.push({
      groupKey,
      nameCount: idxs.length,
      breadth: meanOrNull(idxs.map((i) => breadthOf(items[i]!))),
      compositeMean: meanOrNull(idxs.map((i) => compositeOf(items[i]!))),
    });
  }
  return out.sort((a, b) => (b.compositeMean ?? -Infinity) - (a.compositeMean ?? -Infinity));
}
