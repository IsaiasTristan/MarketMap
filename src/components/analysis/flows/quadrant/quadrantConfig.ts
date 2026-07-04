/**
 * Every tunable threshold for the crowding × conviction chart lives HERE and
 * nowhere else. Runtime-derived values (universe median conviction, p75s,
 * p99.5, the 1/N x-floor) are computed in quadrantModel.ts from the payload —
 * this object holds only the parameters.
 */
export const QUADRANT_CONFIG = {
  /**
   * Foreground = (|Δholders| >= minAbsDelta) OR (holders >= minHolders AND
   * conviction >= the convictionPercentile of the period's universe).
   * Tuned against 2023-Q4→2026-Q1 data to land 30–80 names per quarter
   * (56–72 observed); the spec's original 2/3/median admitted ~690.
   */
  foreground: {
    minAbsDelta: 4,
    minHolders: 5,
    convictionPercentile: 0.9,
    /** If true, Δ==0 names are demoted to background even when they pass the rule above. */
    demoteZeroDelta: false,
  },
  colors: {
    accumulating: "#2a78d6", // Δ holders > 0
    distributing: "#e34948", // Δ holders < 0
    neutral: "#8a8a8a", // Δ holders == 0 (foreground gray)
    background: "#8a8a8a",
    backgroundOpacity: 0.25,
    backgroundRadius: 2.5,
  },
  /** Foreground mark radius = clamp(base + perDelta * |Δholders|, base, max). */
  radius: { base: 4, perDelta: 1.1, max: 12 },
  axes: {
    /** Conviction (y): log domain [floor%, p-ceilPercentile of conviction]. */
    y: { floor: 0.3, ceilPercentile: 0.995, ticks: [0.5, 1, 2, 4, 8] },
    /** Breadth (x): log domain [100/trackedFunds, max breadth * ceilPad]. */
    x: { ceilPad: 1.05, ticks: [2, 5, 10, 20, 40] },
  },
  labels: {
    maxByScore: 15,
    fontSize: 10,
    pad: 2,
    charWidth: 6,
    slots: ["right", "above-right", "below-right", "left"] as const,
  },
  /** Danger zone: breadth > p75 AND conviction > p75 AND Δ < 0 — always labeled. */
  dangerZone: { breadthPercentile: 0.75, convictionPercentile: 0.75 },
  /** Deterministic hash(ticker) x-jitter for discrete low-holder columns. Enabled
   *  because banding stayed visible below 6 holders after the log-x change. */
  jitter: { enabled: true, maxBreadthOffsetPct: 0.25, belowHolders: 6 },
  trails: { strokeWidth: 2, hollowRadius: 3 },
  zones: { percentile: 0.75, defaultOn: true, storageKey: "flows-quadrant-zones", fontSize: 11 },
  streak: { badgeMin: 2 },
  search: { dimOpacity: 0.15 },
  /** Grid-bucket spatial index for hit-testing (Parts 1–3). hitSlop/minHitRadius
   *  reproduce the former inline hitTest acceptance so foreground hover is unchanged. */
  spatial: { cellSize: 32, hitSlop: 4, minHitRadius: 12 },
  /** Semantic zoom (Part 3): brush → animated log-domain interpolation. */
  zoom: { stackDepth: 2, animMs: 240, brushMinPx: 6 },
  /** Density-driven promotion + label budget under zoom (Part 3b/3c).
   *  promoteDensity is points per 10,000 px² below which background marks in
   *  view self-promote to foreground render-state. dragThresholdPx separates a
   *  click from a drag-select. */
  density: { promoteDensity: 6, maxLabels: 25, dragThresholdPx: 4 },
  /** Danger-vector takeaways (Part 4b). */
  vectors: { topN: 5, minTrailQuarters: 2 },
  /** Below-range gutter band beneath the plot (Part 0). floorBps 30 = 0.3% of
   *  book, aligned with axes.y.floor. */
  gutter: { floorBps: 30, height: 28, opacity: 0.18, caption: "< 0.3% of book" },
  /** Box-select region inspector right rail (Part 2). */
  inspector: { width: 260, sort: "conviction" },
  /** Alt-hover pickup radius for context (background) marks (Part 1a). */
  altHover: { radiusPx: 14 },
} as const;
