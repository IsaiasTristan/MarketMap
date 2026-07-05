/**
 * Engine 1 — the single source for every decision-tool threshold. Transition
 * detectors, the scoring/ingest services, AND the metric registry all read
 * this object, so tooltip copy interpolates the same numbers the code runs.
 * Change a threshold here and the behavior + the on-screen definitions move
 * together.
 */

export const REVISION_THRESHOLDS = {
  /** NEW_LONG requires this within-peer-group decile (NEW_SHORT the mirror, decile 1). */
  newFlagDecile: 10,
  /** NEW_LONG / NEW_SHORT also require |gapScore| at or above this. */
  newFlagMinAbsGap: 1.5,
  /** GAP_CLOSED fires when a flagged name's |gapScore| falls below this. */
  gapClosedAbsGap: 0.5,
  /** STREAK_BROKEN requires a prior streak at least this long before the flip. */
  streakBrokenMinLen: 4,
  /** GROUP_INFLECTION / GROUP_ROLLOVER fire when a group mean crosses +-this level. */
  groupCrossLevel: 1.0,
  /** NEXT_DOMINO requires the group mean at or beyond +-this... */
  dominoGroupMinAbsZ: 1.0,
  /** ...while the member's own composite z sits within +-this band. */
  dominoOwnMaxAbsZ: 0.3,
  /** ER_WITHIN_7D fires when the next earnings date is at most this many days out... */
  erWindowDays: 7,
  /** ...and the name's |composite z| is at least this. */
  erMinAbsRevisionZ: 1.0,
  /** Trailing window (grid weeks) for composite4wZ, the revision leg of the gap score. */
  composite4wWindow: 4,
  /** Streaks read the Leg-B reconstruction until Leg A depth reaches this many weeks. */
  legAStreakMinWeeks: 6,
  /** Weeks displayed in the streak block strip. */
  streakDisplayWeeks: 6,
  /** Trailing window (grid weeks) for the epsDispersion trend slope. */
  dispersionTrendWindow: 6,
  /** |slope| below this fraction of the mean dispersion level counts as FLAT. */
  dispersionFlatBand: 0.05,
  /** A reconstructed analyst price target older than this is evicted from the PIT consensus. */
  ptReconStaleDays: 180,
  /** A weekly close is null if the last daily bar is more than this many days before the grid date. */
  priceGridStaleDays: 6,
  /** Weeks of weekly closes backfilled behind the earliest snapshot (13w returns + fwd-return backtests). */
  priceBackfillWeeks: 130,
  /** Weekly price capture re-fetches this many trailing grid weeks (self-heals split/dividend re-adjustments). */
  weeklyPriceRefreshWeeks: 14,
  /** Rolling IC window (grid weeks) for the validation tab. */
  rollingIcWindow: 4,
  /** Forward-return horizon (grid weeks) for IC / decile validation stats. */
  validationHorizonWeeks: 4,
  /** IC series shorter than this renders the insufficient-history placeholder. */
  validationMinWeeks: 8,
  /** The long-run IC average is taken over this many trailing weeks. */
  icLongRunWeeks: 26,
} as const;

/** Widened (all-number) shape so detectors accept modified copies (tests, tuning). */
export type RevisionThresholds = { [K in keyof typeof REVISION_THRESHOLDS]: number };
