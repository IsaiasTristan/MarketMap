/**
 * Engine 2 — cross-box correlation / duplication review (pure, no I/O).
 *
 * Computes pairwise Pearson correlation between the nine box scores across the
 * cross-section of names and flags pairs whose |rho| exceeds a threshold (0.80
 * by default). Report-only: in V1 we do NOT eliminate correlated boxes — the
 * equal-weight composite is unchanged — we surface the duplication so it can be
 * reviewed later (plan section 21).
 */
import { BOX_KEYS, type BoxKey } from "./boxes";

export const DEFAULT_CORRELATION_FLAG = 0.8;
/** Minimum overlapping finite pairs required to report a correlation. */
export const MIN_CORRELATION_OVERLAP = 30;

export interface BoxScoreRecord {
  boxScores?: Partial<Record<BoxKey, number | null>>;
}

export interface BoxPairCorrelation {
  a: BoxKey;
  b: BoxKey;
  rho: number;
  n: number;
}

export interface BoxCorrelationReport {
  /** Symmetric matrix indexed by BOX_KEYS order; null on insufficient overlap. */
  matrix: Array<Array<number | null>>;
  keys: BoxKey[];
  /** Pairs with |rho| >= threshold and n >= minOverlap, sorted by |rho| desc. */
  flagged: BoxPairCorrelation[];
}

/** Pearson correlation over paired finite samples; null if too few pairs or zero variance. */
export function pearson(
  xs: Array<number | null | undefined>,
  ys: Array<number | null | undefined>,
  minOverlap = MIN_CORRELATION_OVERLAP,
): { rho: number; n: number } | null {
  const px: number[] = [];
  const py: number[] = [];
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    px.push(x);
    py.push(y);
  }
  const n = px.length;
  if (n < minOverlap) return null;
  const mx = px.reduce((a, b) => a + b, 0) / n;
  const my = py.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = px[i]! - mx;
    const dy = py[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return { rho: sxy / Math.sqrt(sxx * syy), n };
}

/** Build the cross-box correlation matrix + flagged high-correlation pairs. */
export function boxCorrelationReport(
  rows: BoxScoreRecord[],
  threshold = DEFAULT_CORRELATION_FLAG,
  minOverlap = MIN_CORRELATION_OVERLAP,
): BoxCorrelationReport {
  const keys = [...BOX_KEYS];
  const columns: Record<BoxKey, Array<number | null>> = {} as Record<BoxKey, Array<number | null>>;
  for (const k of keys) columns[k] = rows.map((r) => r.boxScores?.[k] ?? null);

  const matrix: Array<Array<number | null>> = keys.map((_, i) =>
    keys.map((__, j) => (i === j ? 1 : null)),
  );
  const flagged: BoxPairCorrelation[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const res = pearson(columns[keys[i]!]!, columns[keys[j]!]!, minOverlap);
      const rho = res?.rho ?? null;
      matrix[i]![j] = rho;
      matrix[j]![i] = rho;
      if (res && Math.abs(res.rho) >= threshold) {
        flagged.push({ a: keys[i]!, b: keys[j]!, rho: res.rho, n: res.n });
      }
    }
  }
  flagged.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  return { matrix, keys, flagged };
}
