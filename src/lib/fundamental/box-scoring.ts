/**
 * Engine 2 — pure two-level box scorer. No I/O.
 *
 * Level 1: each raw component is z-scored WITHIN its peer group (winsorize +
 *          z, reusing Engine 1's primitives), then a box score = mean of its
 *          available component z-scores.
 * Level 2: the composite = mean of available box scores, requiring at least
 *          MIN_VALID_BOXES valid boxes (else null -> excluded from rank).
 *
 * Deterministic + idempotent: the same component inputs + peer assignment +
 * methodology version always produce the same scores. Emits a full per-component
 * / per-box audit so any score can be reconstructed.
 */
import { zScores } from "@/lib/revision/scoring";
import { BOX_REGISTRY, MIN_VALID_BOXES, flatKey, type BoxKey } from "./boxes";

export interface ComponentAudit {
  key: string; // flat key `${box}.${component}`
  label: string;
  raw: number | null;
  z: number | null;
}

export interface BoxAudit {
  key: BoxKey;
  label: string;
  boxScore: number | null;
  components: ComponentAudit[];
  missingReason: string | null;
}

export interface TickerBoxResult {
  composite: number | null;
  validBoxCount: number;
  boxScores: Record<string, number | null>;
  boxes: BoxAudit[];
  /** Flat component-key -> peer z-score (for the audited scoreJson). */
  componentZ: Record<string, number | null>;
}

export interface BoxScoringInput {
  /** Per-ticker flat component maps (`${box}.${component}` -> oriented raw value). */
  components: Array<Record<string, number | null>>;
  /** Per-ticker peer-group key (subsector-first, sector fallback). */
  peerKeys: string[];
}

function meanFinite(vals: Array<number | null>): number | null {
  const f = vals.filter((v): v is number => v !== null && Number.isFinite(v));
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/** All flat component keys across the registry, in registry order. */
function allFlatKeys(): Array<{ box: BoxKey; comp: string; label: string; flat: string }> {
  const out: Array<{ box: BoxKey; comp: string; label: string; flat: string }> = [];
  for (const box of BOX_REGISTRY) {
    for (const c of box.components) {
      out.push({ box: box.key, comp: c.key, label: c.label, flat: flatKey(box.key, c.key) });
    }
  }
  return out;
}

export function computeBoxScores(input: BoxScoringInput): TickerBoxResult[] {
  const n = input.components.length;
  const flatKeys = allFlatKeys();

  // Peer buckets (index lists keyed by peer group).
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = input.peerKeys[i] ?? "Unclassified";
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  }

  // Level 1: z-score every component within each peer bucket.
  const zByKey = new Map<string, Map<number, number>>();
  for (const { flat } of flatKeys) {
    const global = new Map<number, number>();
    for (const idxs of buckets.values()) {
      const sub = idxs.map((i) => input.components[i]?.[flat] ?? null);
      const { z } = zScores(sub);
      for (const [localIdx, zv] of z) global.set(idxs[localIdx]!, zv);
    }
    zByKey.set(flat, global);
  }

  const results: TickerBoxResult[] = [];
  for (let i = 0; i < n; i++) {
    const componentZ: Record<string, number | null> = {};
    const boxScores: Record<string, number | null> = {};
    const boxes: BoxAudit[] = [];

    for (const box of BOX_REGISTRY) {
      const compAudits: ComponentAudit[] = [];
      const zs: Array<number | null> = [];
      for (const c of box.components) {
        const flat = flatKey(box.key, c.key);
        const raw = input.components[i]?.[flat] ?? null;
        const z = zByKey.get(flat)?.get(i) ?? null;
        componentZ[flat] = z;
        zs.push(z);
        compAudits.push({ key: flat, label: c.label, raw, z });
      }
      const boxScore = meanFinite(zs);
      boxScores[box.key] = boxScore;
      const anyRaw = compAudits.some((c) => c.raw !== null && Number.isFinite(c.raw));
      boxes.push({
        key: box.key,
        label: box.label,
        boxScore,
        components: compAudits,
        missingReason:
          boxScore !== null
            ? null
            : anyRaw
              ? "no peer z-score (insufficient peer coverage)"
              : "no component data",
      });
    }

    const validBoxCount = Object.values(boxScores).filter(
      (v) => v !== null && Number.isFinite(v),
    ).length;
    const composite =
      validBoxCount >= MIN_VALID_BOXES ? meanFinite(Object.values(boxScores)) : null;

    results.push({ composite, validBoxCount, boxScores, boxes, componentZ });
  }
  return results;
}
