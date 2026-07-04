/**
 * Flow Leaderboard — the single knob object.
 *
 * Every tunable parameter for the ranked accumulation heatmap lives HERE and
 * nowhere else (mirrors the quadrantConfig.ts convention). This object holds
 * ONLY static parameters; anything derived from data (z-scores, percentiles,
 * rescaled scores, reason strings) is computed in flow-leaderboard.ts from the
 * precomputed ingredients. No magic numbers in the scoring code.
 *
 * The composite score is a deliberate departure from Engine 3's usual
 * no-composite-score design: on THIS tab the row order IS the product (a
 * leaderboard), so a single ranking number is the point. The other flow tabs
 * keep their raw-counts-plus-two-axes design.
 *
 * Typed with a widened interface (not `as const`) so the config playground /
 * tests can pass overridden copies (e.g. a different exclude_top_n_by_mcap).
 */
export interface SplitDetectConfig {
  min_ratio_holders_pct: number;
  min_funds: number;
  ratio_band: readonly [number, number];
  quarterly_return_band: readonly [number, number];
}
export interface FlowLeaderboardConfig {
  lookback_quarters: number;
  recency_weights: readonly number[];
  adder_threshold_pct: number;
  raw_vs_relative_blend: number;
  count_vs_capital_blend: number;
  streak_bonus_per_qtr: number;
  streak_bonus_cap: number;
  bps_deadzone: number;
  conviction_mult_range: readonly [number, number];
  elite_bonus_per_fund: number;
  elite_bonus_cap: number;
  gates: {
    min_holders: number;
    min_abs_wflow: number;
    min_abs_wflow_bps: number;
    exclude_top_n_by_mcap: number;
    partial_data_pct: number;
  };
  board_size: { accumulation: number; distribution: number };
  split_detect: SplitDetectConfig;
}

export const FLOW_LEADERBOARD_CONFIG: FlowLeaderboardConfig = {
  /** Quarters of history the score looks back over, q0 = latest. */
  lookback_quarters: 4,
  /** Recency weights applied to netflow(q0..q-3); index 0 = latest quarter. */
  recency_weights: [1.0, 0.7, 0.45, 0.25],

  /** A fund is an "adder" when split-adjusted shares rose ≥ this % QoQ (or it
   *  initiated); a "reducer" when they fell ≥ this % (or it exited). */
  adder_threshold_pct: 10,

  /** Within flowz_counts: blend of raw wflow z-score and holder-relative relflow z-score. */
  raw_vs_relative_blend: 0.5,
  /** flowz = blend·flowz_counts + (1-blend)·flowz_cap. [Part-2 amendment] */
  count_vs_capital_blend: 0.5,

  /** Streak multiplier grows by this per extra consecutive quarter, capped. */
  streak_bonus_per_qtr: 0.15,
  streak_bonus_cap: 1.6,
  /** |netflow_bps| at/below this is rounding noise: streak sign falls back to the
   *  count-based sign so a near-zero bps quarter doesn't break a streak. [amendment] */
  bps_deadzone: 2,

  /** Conviction multiplier range, mapped from the cross-sectional percentile of a
   *  name's median position weight. Narrowed in the amendment because capital flow
   *  (flowz_cap) now carries most of the sizing information — avoid double-counting. */
  conviction_mult_range: [0.8, 1.2],

  /** Elite multiplier: 1 + bonus per elite-tier adder in the latest 2 quarters, capped. */
  elite_bonus_per_fund: 0.1,
  elite_bonus_cap: 1.3,

  gates: {
    /** Minimum signal-tier holders for a name to appear. */
    min_holders: 3,
    /** A name qualifies on EITHER |wflow| ≥ min_abs_wflow ... */
    min_abs_wflow: 4,
    /** ... OR |wflow_bps| ≥ min_abs_wflow_bps, so pure-deepening names reach the board. [amendment] */
    min_abs_wflow_bps: 6,
    /** Exclude the N largest names by point-in-time market cap (mega-cap flow is noise). */
    exclude_top_n_by_mcap: 15,
    /** If more than this fraction of a name's latest-quarter holders are missing
     *  filings, badge the row "partial data" rather than silently mis-scoring. */
    partial_data_pct: 0.1,
  },

  /** How many rows each board shows. */
  board_size: { accumulation: 20, distribution: 10 },

  /** Split detector (see split-detect.service.ts). */
  split_detect: {
    /** Fraction of continuing holders that must share the common ratio R. */
    min_ratio_holders_pct: 0.7,
    /** Minimum continuing holders for the detector to fire at all. */
    min_funds: 5,
    /** A per-fund share ratio inside this band is "no change" (not a split candidate). */
    ratio_band: [0.9, 1.1],
    /** Implied-price corroboration: median(ip_q/ip_{q-1})·R must land in this
     *  plausible-quarterly-gross-return band for a true split. */
    quarterly_return_band: [0.5, 2.0],
  },
};
