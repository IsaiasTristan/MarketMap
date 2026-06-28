/**
 * Engine 2 — display-layer chart scaling helpers. Pure, no I/O.
 *
 * Fundamental ratios on loss-making / near-zero-capital names (e.g. a pre-revenue
 * SPAC) explode to magnitudes thousands of times the typical range, which would
 * stretch an auto-scaled axis and collapse every normal name onto a flat line.
 * `robustDomain` returns a percentile-clipped [lo, hi] so callers can pin those
 * outliers to the chart edge instead. This changes only how values are drawn —
 * never the underlying signals/scores.
 */

/** Linear-interpolated percentile of an already-sorted ascending array. */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const clampedP = Math.min(1, Math.max(0, p));
  const idx = clampedP * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export interface RobustDomainOptions {
  /** Lower percentile (0..1). Default 0.02. */
  loP?: number;
  /** Upper percentile (0..1). Default 0.98. */
  hiP?: number;
  /** Symmetric padding as a fraction of the clipped span. Default 0.05. */
  pad?: number;
  /** Minimum finite points required to bother clipping. Default 5. */
  minCount?: number;
}

/**
 * Percentile-clipped, padded [lo, hi] domain for a set of values, or null when
 * there are too few finite points (caller should fall back to auto-domain).
 * When the clipped low and high coincide (degenerate / all-equal), the band is
 * nudged outward so the axis still has a non-zero span.
 */
export function robustDomain(
  values: Array<number | null | undefined>,
  opts: RobustDomainOptions = {},
): [number, number] | null {
  const { loP = 0.02, hiP = 0.98, pad = 0.05, minCount = 5 } = opts;
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < minCount) return null;

  const sorted = [...finite].sort((a, b) => a - b);
  let lo = percentileSorted(sorted, loP);
  let hi = percentileSorted(sorted, hiP);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  if (hi <= lo) {
    const nudge = Math.max(Math.abs(lo), 1) * 0.01;
    lo -= nudge;
    hi += nudge;
  } else if (pad > 0) {
    const padAmt = (hi - lo) * pad;
    lo -= padAmt;
    hi += padAmt;
  }
  return [lo, hi];
}

/** Clamp a value into [lo, hi] (outliers pin to the boundary for plotting). */
export function clampValue(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.min(hi, Math.max(lo, v));
}
