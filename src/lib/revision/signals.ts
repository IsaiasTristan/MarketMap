/**
 * Engine 1 — pure per-stock revision signal math. No I/O. The scoring service
 * maps DB rows into `StockWeek` and calls `computeRawSignals` with the current
 * and prior-week views; the engine is a change detector, so most signals are
 * week-over-week deltas (null when there is no prior week, e.g. Leg A on the
 * first run — that signal is intentionally forward-accruing).
 */

/** Metrics tracked for Leg A estimate-revision breadth. */
export const BREADTH_METRICS = ["revenue", "eps", "ebitda", "ebit", "netIncome"] as const;
export type BreadthMetric = (typeof BREADTH_METRICS)[number];

export interface RatingDist {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface StockWeek {
  ticker: string;
  epsAvg: number | null;
  revenueAvg: number | null;
  /** Forward-period consensus avg per metric (for breadth). */
  metricAvgs: Partial<Record<BreadthMetric, number | null>>;
  epsLow: number | null;
  epsHigh: number | null;
  ratingDist: RatingDist | null;
  ptConsensus: number | null;
  daysToEarnings: number | null;
  /** Fiscal date of the forward period `metricAvgs`/`epsAvg`/`revenueAvg` describe. */
  forwardFiscalDate?: string | null;
  /**
   * Consensus avgs per fiscal period from this week's estimatesJson, keyed by
   * fiscalDate. Lets a revision compare the SAME fiscal period across weeks
   * instead of jumping FY1→FY2 the week a fiscal year-end rolls (which fakes a
   * simultaneous eps/revenue/breadth "revision").
   */
  periodAvgs?: Map<string, Partial<Record<BreadthMetric, number | null>>>;
}

export interface RawSignals {
  // Leg A (forward-accruing) — null without a prior week.
  epsRevision: number | null;
  revenueRevision: number | null;
  estimateBreadth: number | null;
  epsDispersion: number | null;
  // Leg B (backtestable) — level + momentum.
  ratingNet: number | null;
  ratingMomentum: number | null;
  ptRevision: number | null;
}

/** Relative change, guarded against zero/sign-flip denominators. */
export function relChange(curr: number | null, prior: number | null): number | null {
  if (curr === null || prior === null) return null;
  const denom = Math.abs(prior);
  if (denom < 1e-9) return null;
  return (curr - prior) / denom;
}

/** Bull-minus-bear share of the rating distribution, in [-1, 1]. */
export function ratingNet(d: RatingDist | null): number | null {
  if (!d) return null;
  const total = d.strongBuy + d.buy + d.hold + d.sell + d.strongSell;
  if (total <= 0) return null;
  const bull = d.strongBuy + d.buy;
  const bear = d.sell + d.strongSell;
  return (bull - bear) / total;
}

/** Estimate-revision breadth: (up - down) / total across tracked metric avgs. */
export function estimateBreadth(
  curr: StockWeek["metricAvgs"],
  prior: StockWeek["metricAvgs"] | null,
): number | null {
  if (!prior) return null;
  let up = 0;
  let down = 0;
  let total = 0;
  for (const m of BREADTH_METRICS) {
    const c = curr[m];
    const p = prior[m];
    if (c === null || c === undefined || p === null || p === undefined) continue;
    if (Math.abs(p) < 1e-9) continue;
    total++;
    const ch = c - p;
    if (ch > 0) up++;
    else if (ch < 0) down++;
  }
  if (total === 0) return null;
  return (up - down) / total;
}

/** Analyst-disagreement read: (high - low) / |avg| of the forward EPS estimate. */
export function epsDispersion(low: number | null, avg: number | null, high: number | null): number | null {
  if (low === null || high === null || avg === null) return null;
  const denom = Math.abs(avg);
  if (denom < 1e-9) return null;
  return (high - low) / denom;
}

/**
 * Proximity-to-earnings weight in [1, 1+maxBoost]. Revisions in a compressed
 * pre-announcement window reflect higher conviction. Linear ramp inside
 * `windowDays`; 1.0 outside or when the date is unknown.
 */
export function proximityWeight(
  daysToEarnings: number | null,
  windowDays = 30,
  maxBoost = 1,
): number {
  if (daysToEarnings === null || daysToEarnings < 0 || daysToEarnings > windowDays) return 1;
  return 1 + maxBoost * ((windowDays - daysToEarnings) / windowDays);
}

/**
 * Current-week consensus avgs for the SAME forward fiscal period the prior week
 * tracked — so a revision measures a like-for-like estimate change, not a
 * fiscal-year-roll level jump. Returns:
 *  - the current avgs for `prior.forwardFiscalDate` when the period map has it
 *    (normal week: identical to `curr.metricAvgs`; roll week: the real revision
 *    of the just-passed year's estimate);
 *  - an empty set on a roll week where FMP no longer estimates the prior period
 *    (no like-for-like comparison → null revision, never a spurious jump);
 *  - `curr.metricAvgs` as the legacy fallback when the period map or prior
 *    forward date is unavailable (pre-fix snapshots, unit fixtures).
 */
export function matchedCurrentAvgs(
  curr: StockWeek,
  prior: StockWeek,
): Partial<Record<BreadthMetric, number | null>> {
  if (curr.periodAvgs && prior.forwardFiscalDate) {
    const m = curr.periodAvgs.get(prior.forwardFiscalDate);
    if (m) return m;
    if (curr.forwardFiscalDate && curr.forwardFiscalDate !== prior.forwardFiscalDate) return {};
  }
  return curr.metricAvgs;
}

export function computeRawSignals(curr: StockWeek, prior: StockWeek | null): RawSignals {
  const w = proximityWeight(curr.daysToEarnings);
  // Like-for-like: prior's forward-period avgs vs current's avgs for THAT period.
  const priorAvgs = prior?.metricAvgs ?? null;
  const currMatched = prior ? matchedCurrentAvgs(curr, prior) : null;
  const epsRevision = relChange(currMatched?.eps ?? null, priorAvgs?.eps ?? null);
  const revenueRevision = relChange(currMatched?.revenue ?? null, priorAvgs?.revenue ?? null);
  const breadth = estimateBreadth(currMatched ?? {}, priorAvgs);
  const netNow = ratingNet(curr.ratingDist);
  const netPrior = ratingNet(prior?.ratingDist ?? null);
  const ratingMomentum = netNow !== null && netPrior !== null ? netNow - netPrior : null;
  const ptRevision = relChange(curr.ptConsensus, prior?.ptConsensus ?? null);

  return {
    epsRevision: epsRevision === null ? null : epsRevision * w,
    revenueRevision: revenueRevision === null ? null : revenueRevision * w,
    estimateBreadth: breadth, // breadth is a count ratio; proximity left unweighted
    epsDispersion: epsDispersion(curr.epsLow, curr.epsAvg, curr.epsHigh),
    ratingNet: netNow,
    ratingMomentum: ratingMomentum === null ? null : ratingMomentum * w,
    ptRevision: ptRevision === null ? null : ptRevision * w,
  };
}

/** Directional signals that compose the change-detector composite (higher = bullish inflection). */
export const COMPOSITE_SIGNALS: Array<keyof RawSignals> = [
  "epsRevision",
  "revenueRevision",
  "estimateBreadth",
  "ratingMomentum",
  "ptRevision",
];
