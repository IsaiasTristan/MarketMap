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
} as const;
