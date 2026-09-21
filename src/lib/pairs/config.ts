/**
 * Pairs tab — the single source for every decision-tool threshold. The flag
 * rules, the group/pair services AND the metric registry all read this object,
 * so tooltip copy interpolates the same numbers the code runs. Every threshold
 * here is a STARTING default to be tuned against live output (brief §15.4);
 * note that retuning burns the held-out Validation sample.
 */

export const PAIR_THRESHOLDS = {
  /** A group needs at least this many names to be a Tier-1 basket; below it a
   *  subsector falls back to its parent sector (matches the z-score convention). */
  minGroupNames: 8,
  /** Hedge efficiency below this => "not a pair"; excluded from default ranking,
   *  shown dimmed when the filter is relaxed. */
  minHedgeEff: 0.3,
  /** UNPRICED: signal gap widened more than this (pp) over 4 weeks... */
  unpricedGapPp: 8,
  /** ...AND relReturn1m stayed within +-this (fraction). */
  unpricedRelBand: 0.03,
  /** Both engines "agree" on an unpriced gap when each has a same-direction,
   *  calibrated z-difference of at least this magnitude. Replaces the old
   *  float-equality BOTH test that could never fire. */
  unpricedAgreeMinZ: 1,
  /** E2_UNPRICED carry: the E2 gap is piecewise-constant (quarterly), so its
   *  most recent step is carried forward this many grid weeks (one quarter)
   *  before it expires — a stale step must not fire indefinitely. */
  e2StepMaxCarryWeeks: 13,
  /** TRIANGULATED: an E1 firing and an E2 firing for the same pair count as
   *  triangulated when they land within +-this many grid steps of each other. */
  triangulationWindowWeeks: 6,
  /** THIN_GAP noise floor. One name flipping cut-to-raise moves a leg's breadth
   *  by 200/n pp, so a gap under that is less than one analyst changing their
   *  mind on the SMALLER leg — noise, not a divergence. max(pp, name-equivalent)
   *  tightens automatically as baskets shrink, which is where breadth is least
   *  trustworthy. SET ONCE: "UNPRICED minus THIN_GAP" is a CANDIDATE rule
   *  awaiting Validation evidence, not a second event definition to retune. */
  thinGapMinPp: 8,
  thinGapNameEquivPp: 200,
  /** Display-only: max appearances of one leg in the rendered rank list.
   *  Never affects stored ranking, flags, or the event population. */
  legDisplayCap: 2,
  /** PRICED: relReturn3m above this (fraction)... */
  pricedRel3m: 0.15,
  /** ...OR priceRatioZ above this. */
  pricedRatioZ: 1.5,
  /** FACTOR_BET: residual share (% of spread variance that is idiosyncratic)
   *  below this => the pair is mostly a bet on `topFactor`. */
  factorBetResidualPct: 40,
  /** CROWDED_LONG: crowdingLong above this percent => late trade. */
  crowdedLongPct: 60,
  /** SHORT_LEG_OWNED: crowdingShort above this percent => funds still own it. */
  shortLegOwnedPct: 40,
  /** A single name is "crowded" when more than this percent of watchlist funds
   *  hold it — set from the live cross-sectional p90 (4.17% = 5 of 120 funds),
   *  not a round number. crowdBreadth counts the share of a basket above it. */
  crowdNameMinPct: 4.17,
  /** NARROWING: gap still positive but its 4-week change is negative. */
  /** Matrix arrow glyph / NEW-to-decile: gap moved at least this (pp) in 4 weeks. */
  gapMoveArrowPp: 8,
  /** ENGINES_DISAGREE: both |e1Gap| and |e2Gap| at or above this (pp) with
   *  opposite sign — the variant-perception setup, never suppressed. */
  enginesDisagreeMinPp: 5,
  /** Top decile threshold for arrivals/departures + the NEW flag. */
  topDecile: 9,
  /** unpricedGap needs this many of the pair's OWN weekly observations before a
   *  z-score is shown; below it the cell shows raw pp/% marked uncalibrated. */
  calibrationMinWeeks: 52,
  /** priceRatioZ is measured against this many weeks of the pair's own history. */
  ratioZWindowWeeks: 260,
  /** Change in signal gap is measured over this many grid steps ("4w"). */
  gapChangeSteps: 4,
  /** Hedge efficiency + spread factor regression use this many weekly returns. */
  hedgeEffWeeks: 104,
  /** Sparklines show this many trailing weekly values. */
  seriesWeeks: 13,
  /** Small-cap beta shrinkage toward the subsector mean (Hedge Finder). */
  betaShrinkLambda: 0.3,
  /** Hedge Finder basket: names selected by greedy forward selection. */
  basketMaxNames: 8,
  /** Per-name weight cap in a hedge basket (fraction of gross short). */
  basketNameCap: 0.4,
  /** Hedge Finder single-name candidate gate: keep only names in the bottom
   *  this-many deciles on Engine 1 OR Engine 2 (weak = a sensible short). */
  hedgeWeakMaxDecile: 3,
  /** Minimum average daily $ volume for a short candidate (informational only
   *  until a volume ingest exists — the probe found PriceHistory.volume empty). */
  minAdvUsd: 5_000_000,

  // --- Tier 2: single stocks within one subsector (brief §4.3, §6.2) ---
  /** Names taken from each end (top-k long, bottom-k short) after kills. */
  tier2K: 5,
  /** A subsector needs at least this many names to form a Tier-2 pair, so 5
   *  can still be taken from each end after quality kills. */
  tier2MinSubsectorNames: 12,
  /** Tier 2 is driven off the dispersion map and is near-useless for
   *  low-dispersion groups: require the subsector's dispersion percentile
   *  to be at or above this before a Tier-2 pair is formed. */
  tier2MinDispersionPctile: 50,

  // --- Tier 3: curated economic links + read-through (brief §4.4, §6.3) ---
  /** The side that "fired" must have an |Engine z| at or above this. */
  tier3FiredZ: 1.5,
  /** The other side is still "quiet" while its |Engine z| stays below this. */
  tier3QuietZ: 0.5,
  /** Weeks the fired side must persist (quiet other side) before WATCH. */
  tier3WatchWeeks: 4,
  /** After this many weeks with no read-through the link resets to NEW. */
  tier3MaxWeeks: 13,

  // --- Validation: pooled event study, hard-gated headline (brief §10) ---
  /** Effective independent weeks required before the headline shows a number. */
  validationHeadlineMinWeeks: 26,
  /** Distinct pairs required before the headline shows a number. */
  validationHeadlineMinPairs: 30,
  /** Calendar span (months) required — a large sample in one regime cannot
   *  clear the gate, because the year-by-year panel cannot run on six months. */
  validationHeadlineMinSpanMonths: 18,
  /** A slice row needs this many events before its stats are un-dimmed. */
  validationSliceMinEvents: 300,
  /** A slice row's |t| must reach this before it is un-dimmed. */
  validationSliceMinT: 1,
  /** Below this many events a slice row's median / hit / t / IC are SUPPRESSED
   *  (rendered as em-dash), not merely dimmed — a dimmed -1.93 on 2 events still
   *  reads as near-significant. */
  validationSuppressBelowEvents: 50,
  /** Below this many distinct weeks a slice row's stats are likewise suppressed,
   *  so a t computed off two or three weeks never renders. */
  validationSuppressBelowWeeks: 8,
} as const;

/** The held-out period start. Stored on every validation snapshot so retuning
 *  the thresholds toward it is a visible, auditable act (brief §10, §15.4).
 *  NOTE: 2026 has been inside the pooled headline and visible in the year panel,
 *  so it is "observed out-of-sample", not a pristine reserve — see
 *  docs/pairs/validation-precommit.md. */
export const VALIDATION_HELD_OUT_FROM = "2026-01-01";

/** A genuinely clean forward reserve, declared on 2026-09-20 and displayed
 *  NOWHERE until its precommitted trigger is met (>= 1,000 events with a
 *  complete 4-week forward window AND >= 6 calendar months). See the precommit
 *  doc for the unlock rule and acceptance criteria. */
export const VALIDATION_FORWARD_RESERVE_FROM = "2026-09-20";

/** Widened (all-number) shape so rules/tuning accept modified copies. */
export type PairThresholds = { [K in keyof typeof PAIR_THRESHOLDS]: number };
