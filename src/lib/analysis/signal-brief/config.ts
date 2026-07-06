/**
 * Overview SIGNAL BRIEF — the single source for every verdict / severity
 * threshold used by the portfolio-lens modules (scatter verdicts, what-changed
 * feed, earnings window). The pure rules (rules.ts), the composing read
 * service, AND the metric registry all read this object, so tooltip copy
 * interpolates the same numbers the code runs. Follows the Engine-1
 * REVISION_THRESHOLDS pattern.
 *
 * The scatter verdict is a LABEL, never a blended score — agreement between
 * the revision and 13F legs is stated, not numerically combined.
 */

export const SIGNAL_BRIEF_THRESHOLDS = {
  /** CONFIRM requires the revision gap score at or above this... */
  verdictConfirmMinGap: 1.0,
  /** ...AND 13F net flow (bps) at or above this (an active NEW_LONG transition substitutes for flow). */
  verdictConfirmMinFlowBps: 20,
  /** AGAINST fires when the gap score is at or below this (negative events also force AGAINST). */
  verdictAgainstMaxGap: -1.0,
  /** Non-held names only enter the feed as new ideas with |gap| at or above this (mirrors revision newFlagMinAbsGap). */
  newIdeaMinAbsGap: 1.5,
  /** Stasis-break events below this significance are ignored (matches the core-holdings read filter). */
  stasisBreakMinSignificance: 0.75,
  /** The single group-rotation feed row requires |net diffusion %| at or above this to appear at all. */
  rotationRowMinAbsDiffusionPct: 15,
  /** Hard cap on what-changed feed rows. */
  feedMaxRows: 6,
  /** Earnings timeline lookahead window (days). */
  earningsWindowDays: 21,
  /** 13F filings arrive up to ~this many days after quarter end (the lag caveat on every flow stamp). */
  flowLagDays: 45,
} as const;

/** Widened (all-number) shape so rules accept modified copies (tests, tuning). */
export type SignalBriefThresholds = {
  [K in keyof typeof SIGNAL_BRIEF_THRESHOLDS]: number;
};
