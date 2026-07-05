/**
 * FUNDS tab (signal provenance) — the single knob object.
 *
 * Every tunable for follow attribution, exit-lead attribution, the fresh-calls
 * feed, and the Distribution-Watch churn baseline lives HERE (mirrors the
 * flow-leaderboard-config.ts / quadrantConfig.ts convention). Widened interface +
 * const (NOT `as const`) so the config playground / tests can pass overridden
 * copies. Only static parameters live here; anything derived from data (rates,
 * medians, cohorts) is computed in the pure cores from these values.
 *
 * The qualified-initiation thresholds themselves (min_entry_bps, min_sizing_mult,
 * strength cap, guards) are NOT duplicated here — they live in INITIATION_CONFIG
 * (initiation.ts) and reach this layer as the precomputed
 * FundHoldingSnapshot.initiationStrength column. Tenure lives in
 * CORE_HOLDINGS_CONFIG (core-holdings.ts). This object owns only the
 * fund-attribution layer on top of those.
 */

export interface InterimQualityWeight {
  /** fund_quality_weight for elite (isMostRespected) funds. */
  elite: number;
  /** fund_quality_weight for non-elite signal funds. */
  base: number;
}

export interface FundsAttributionConfig {
  /** Distinct signal-tier follower funds within the window for an episode to be FOLLOWED. */
  follow_min_funds: number;
  /** ASYMMETRIC follow design: the ORIGINATOR must clear the full qualified-initiation
   *  bar (≥ min_entry_bps AND ≥ min_sizing_mult; see INITIATION_CONFIG), but a FOLLOW
   *  VOTE only needs a NEW position ≥ this materiality floor (bps of book) — no
   *  sizing-multiple gate. A late fund confirming a call by opening even a modestly
   *  sized starter position still counts as following; sub-floor dust does not. Mirrors
   *  INITIATION_CONFIG.min_entry_bps (25). The sizing multiple stays a WEIGHT in
   *  cluster strength / significance, never a follower gate. */
  follow_min_bps: number;
  /** Follow / exit-lead window (quarters after q0, exclusive of q0). */
  follow_window: number;
  /** Trailing quarters of a fund's qualified entries that feed its rate. */
  stat_window: number;
  /** Below this resolved-N a fund's rate renders "n/a" and the row dims. */
  min_n_for_rate: number;
  /** Qualified trim/exit: share reduction (%) of a material position, or a full exit. */
  trim_min_pct: number;
  /** Receipt-meter render cap; blocks beyond this collapse into a "+N" suffix. */
  meter_max_blocks: number;
  /** Fresh-calls rank discount for originators below min_n_for_rate (cohort median × this). */
  fresh_lown_discount: number;
  /** Minimum per-sector resolved-N for a fund's "best sector" to be eligible. */
  sector_min_n: number;
  /** Trailing quarters for the Distribution-Watch churn mean/sd baseline. */
  churn_baseline_window: number;
  /** Interim fund-quality weight until the returns-engine clone-alpha ships.
   *  TODO(returns-engine): replace with the real per-fund clone-alpha stat. */
  interim_quality_weight: InterimQualityWeight;
}

export const FUNDS_ATTRIBUTION_CONFIG: FundsAttributionConfig = {
  follow_min_funds: 3,
  follow_min_bps: 25, // materiality floor for a follow vote (mirrors INITIATION_CONFIG.min_entry_bps)
  follow_window: 3,
  stat_window: 12,
  min_n_for_rate: 8,
  trim_min_pct: 25,
  meter_max_blocks: 48,
  fresh_lown_discount: 0.5,
  sector_min_n: 5,
  churn_baseline_window: 8,
  // TODO(returns-engine): swap for computed clone-alpha per fund.
  interim_quality_weight: { elite: 1.2, base: 1.0 },
};
