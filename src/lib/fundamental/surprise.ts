/**
 * Box 2 — Earnings & Revenue Surprise. Pure math, no I/O. Measures whether
 * reported results beat or missed the consensus that stood immediately before
 * the report. All components are oriented so HIGHER = BETTER (a bigger positive
 * surprise is better) before the cross-sectional z-score in the scoring layer.
 *
 * Denominator floors keep near-zero / negative expectations well-behaved: the
 * surprise sign is always sign(actual - expected) because the denominator is
 * forced positive, so a beat is positive even when consensus was a loss.
 */

/** Floor on |expected EPS| so a near-zero estimate can't explode the ratio. */
export const EPS_DENOM_FLOOR = 0.25;
/** Floor on |expected revenue| (absolute $) — guards a degenerate ~0 estimate. */
export const REVENUE_DENOM_FLOOR = 1;

export interface ReportedVsExpected {
  actual: number | null;
  expected: number | null;
}

/** (actual - expected) / max(|expected|, floor). Null if either side is missing. */
export function surpriseRatio(
  actual: number | null,
  expected: number | null,
  floor: number,
): number | null {
  if (actual === null || expected === null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return null;
  const denom = Math.max(Math.abs(expected), floor);
  if (denom < 1e-12) return null;
  return (actual - expected) / denom;
}

/** Mean of the available surprise ratios over the trailing reports (up to `n`). */
function avgSurprise(reports: ReportedVsExpected[], floor: number, n = 4): number | null {
  const recent = reports.slice(-n);
  const vals: number[] = [];
  for (const r of recent) {
    const s = surpriseRatio(r.actual, r.expected, floor);
    if (s !== null) vals.push(s);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export interface SurpriseInputs {
  /** Chronological (oldest -> newest) per-report EPS actual/expected. */
  eps: ReportedVsExpected[];
  /** Chronological (oldest -> newest) per-report revenue actual/expected. */
  revenue: ReportedVsExpected[];
}

export const SURPRISE_COMPONENT_KEYS = [
  "latestEpsSurprise",
  "latestRevenueSurprise",
  "avg4EpsSurprise",
  "avg4RevenueSurprise",
] as const;

export type SurpriseComponents = Record<(typeof SURPRISE_COMPONENT_KEYS)[number], number | null>;

/** Compute the four surprise components (already oriented higher = better). */
export function surpriseComponents(inputs: SurpriseInputs): SurpriseComponents {
  const lastEps = inputs.eps.at(-1) ?? null;
  const lastRev = inputs.revenue.at(-1) ?? null;
  return {
    latestEpsSurprise: lastEps ? surpriseRatio(lastEps.actual, lastEps.expected, EPS_DENOM_FLOOR) : null,
    latestRevenueSurprise: lastRev
      ? surpriseRatio(lastRev.actual, lastRev.expected, REVENUE_DENOM_FLOOR)
      : null,
    avg4EpsSurprise: avgSurprise(inputs.eps, EPS_DENOM_FLOOR, 4),
    avg4RevenueSurprise: avgSurprise(inputs.revenue, REVENUE_DENOM_FLOOR, 4),
  };
}
