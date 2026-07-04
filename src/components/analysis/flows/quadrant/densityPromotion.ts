/**
 * Density-driven promotion + label budget for the semantic-zoom view (Part 3).
 *
 * After a zoom, if the visible marks are sparse enough, background (context)
 * marks inside the view "self-promote" to foreground render-state — bigger,
 * hoverable without a modifier, and eligible for labels via the SAME
 * placeLabels function foreground uses. Promotion is render-state, never a data
 * mutation. Pure — no React/DOM.
 */
import type { Domain } from "./zoomState";
import type { LabelInput } from "./labelPlacement";

export interface ViewPoint {
  ticker: string;
  x: number;
  y: number;
  r: number;
  /** |Δholders| * conviction — foreground label ranking metric. */
  score: number;
  /** median % of book — density-promoted label ranking metric. */
  conviction: number;
  danger: boolean;
}

/** Points per 10,000 px² of plot area. Infinite when the area is degenerate. */
export function computeDensity(visibleCount: number, plotAreaPx: number): number {
  if (plotAreaPx <= 0) return Infinity;
  return (visibleCount / plotAreaPx) * 10000;
}

/**
 * Data-space filter: which points fall inside the effective (zoomed) domain.
 * Null-conviction names are excluded (they live in the gutter, not the body).
 * Boundaries are inclusive.
 */
export function pointsInView<T extends { breadth: number; conviction: number | null }>(
  pts: T[],
  xDomain: Domain,
  yDomain: Domain,
): T[] {
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  return pts.filter((p) => {
    if (p.conviction === null) return false;
    return p.breadth >= x0 && p.breadth <= x1 && p.conviction >= y0 && p.conviction <= y1;
  });
}

/**
 * Below `promoteDensity`, every in-view background mark promotes; at or above it,
 * none do. Returns the set of promoted tickers (render-state only).
 */
export function selectPromoted(bgInView: ViewPoint[], density: number, promoteDensity: number): Set<string> {
  if (density >= promoteDensity) return new Set();
  return new Set(bgInView.map((p) => p.ticker));
}

/**
 * Budget-capped, priority-ordered label candidates for placeLabels.
 * Tiers (priority, higher wins): foreground = 2, density-promoted = 1. Names in
 * `pinnedTickers` are drawn separately (always-on) and excluded here to avoid
 * double-labeling. Within a tier, foreground orders by score and promoted by
 * conviction. Deterministic; truncated to `maxLabels` before geometric placement.
 */
export function selectLabelCandidates(args: {
  foreground: ViewPoint[];
  promoted: ViewPoint[];
  pinnedTickers: Set<string>;
  maxLabels: number;
  badgeOf: (ticker: string) => string;
}): LabelInput[] {
  const { foreground, promoted, pinnedTickers, maxLabels, badgeOf } = args;
  const chosen = new Map<string, { vp: ViewPoint; priority: number; metric: number }>();
  const consider = (vp: ViewPoint, priority: number, metric: number) => {
    if (pinnedTickers.has(vp.ticker)) return;
    const ex = chosen.get(vp.ticker);
    if (!ex || priority > ex.priority) chosen.set(vp.ticker, { vp, priority, metric });
  };
  for (const vp of foreground) consider(vp, 2, vp.score);
  for (const vp of promoted) consider(vp, 1, vp.conviction);

  const ranked = [...chosen.values()].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    // forced (danger) ahead within the same tier so critical calls survive the cap
    if (a.vp.danger !== b.vp.danger) return a.vp.danger ? -1 : 1;
    if (b.metric !== a.metric) return b.metric - a.metric;
    return a.vp.ticker < b.vp.ticker ? -1 : a.vp.ticker > b.vp.ticker ? 1 : 0;
  });

  return ranked.slice(0, Math.max(0, maxLabels)).map(({ vp, priority, metric }) => {
    const badge = badgeOf(vp.ticker);
    return {
      id: vp.ticker,
      x: vp.x,
      y: vp.y,
      r: vp.r,
      text: badge ? `${vp.ticker} ${badge}` : vp.ticker,
      score: metric,
      forced: vp.danger,
      priority,
    };
  });
}
