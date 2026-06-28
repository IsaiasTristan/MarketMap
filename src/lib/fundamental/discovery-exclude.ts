/**
 * Engine 2 — client-side "what-if" recompute of the discovery composite, decile,
 * and rank when one or more boxes are excluded. No I/O.
 *
 * Mirrors the server scorer exactly: composite = mean of the available (non-
 * excluded) box scores, gated by `validBoxCount >= MIN_VALID_BOXES - excludedCount`;
 * deciles via `rankAndDecile` within sector / subsector peer groups (same
 * `?? "Unclassified"` fallbacks as the scoring service); rank via a global
 * `rankAndDecile` on the recomputed composite. Display/analysis-only — never
 * writes back to the stored V1 composite.
 */
import { rankAndDecile } from "@/lib/revision/scoring";
import { BOX_REGISTRY, MIN_VALID_BOXES, type BoxKey } from "./boxes";

export interface ExcludeRowInput {
  ticker: string;
  sector: string | null;
  subsector: string | null;
  boxScores?: Partial<Record<BoxKey, number | null>>;
}

export interface ExcludeRecomputed {
  composite: number | null;
  validBoxCount: number;
  sectorDecile: number | null;
  subsectorDecile: number | null;
  rank: number | null;
}

function meanFinite(vals: Array<number | null | undefined>): number | null {
  const f = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

function decilesWithinGroups(
  composites: Array<number | null>,
  groupKeys: string[],
): Array<number | null> {
  const out: Array<number | null> = new Array(composites.length).fill(null);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < composites.length; i++) {
    const k = groupKeys[i] ?? "Unclassified";
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  }
  for (const idxs of buckets.values()) {
    const sub = idxs.map((i) => composites[i] ?? null);
    for (const e of rankAndDecile(sub)) out[idxs[e.index]!] = e.decile;
  }
  return out;
}

/**
 * Recompute composite / decile / rank for every row with `excluded` boxes
 * removed from the composite. Returns a map keyed by ticker. Callers should
 * skip the recompute entirely when `excluded` is empty (the result then equals
 * the stored values).
 */
export function recomputeDiscoveryExclusions(
  rows: ExcludeRowInput[],
  excluded: Set<BoxKey>,
): Map<string, ExcludeRecomputed> {
  const remainingKeys = BOX_REGISTRY.map((b) => b.key).filter((k) => !excluded.has(k));
  const threshold = MIN_VALID_BOXES - excluded.size;

  const composites: Array<number | null> = new Array(rows.length).fill(null);
  const validCounts: number[] = new Array(rows.length).fill(0);

  for (let i = 0; i < rows.length; i++) {
    const scores = remainingKeys.map((k) => rows[i]!.boxScores?.[k] ?? null);
    const validBoxCount = scores.filter((v) => v != null && Number.isFinite(v)).length;
    validCounts[i] = validBoxCount;
    composites[i] = validBoxCount >= threshold ? meanFinite(scores) : null;
  }

  const sectorKeys = rows.map((r) => r.sector?.trim() || "Unclassified");
  const subsectorKeys = rows.map((r) => r.subsector?.trim() || r.sector?.trim() || "Unclassified");
  const sectorDeciles = decilesWithinGroups(composites, sectorKeys);
  const subsectorDeciles = decilesWithinGroups(composites, subsectorKeys);

  const rankByIndex = new Map<number, number>();
  for (const e of rankAndDecile(composites)) rankByIndex.set(e.index, e.rank);

  const out = new Map<string, ExcludeRecomputed>();
  for (let i = 0; i < rows.length; i++) {
    out.set(rows[i]!.ticker, {
      composite: composites[i] ?? null,
      validBoxCount: validCounts[i]!,
      sectorDecile: sectorDeciles[i] ?? null,
      subsectorDecile: subsectorDeciles[i] ?? null,
      rank: rankByIndex.get(i) ?? null,
    });
  }
  return out;
}
