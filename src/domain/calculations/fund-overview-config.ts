/**
 * Fund Overview — the single knob object.
 *
 * Every tunable parameter for the fund dossier (returns engine, peer comparisons,
 * book snapshot, style-over-time, search) lives HERE and nowhere else (mirrors the
 * flow-leaderboard-config.ts / quadrantConfig.ts convention). This object holds
 * ONLY static parameters; anything derived from data (returns, z-scores,
 * percentiles, verdict strings) is computed in the pure cores from these knobs.
 *
 * The metric registry (Part 4) interpolates the numbers a definition cites (25 bps,
 * turnover bands, ±10%) straight from THIS object, so the tooltip copy physically
 * cannot drift from the code that computes the metric.
 *
 * Typed with a widened interface (not `as const`) so the registry-consistency test
 * can render definitions against an overridden copy.
 */
export interface FundOverviewConfig {
  /** Benchmark security ticker. SPY.adjClose is dividend-reinvested = S&P 500 TOTAL
   *  return; ^GSPC is price-only and would bias clone alpha high by the dividend yield. */
  benchmark_symbol: string;
  /** Return-confidence bands from trailing-4q turnover (%/q). HIGH < high · MED
   *  [high,med] · LOW > med. */
  return_conf_bands: { high: number; med: number };
  /** Below this % of book value with usable return data, tag LOW COVERAGE, renormalize
   *  over covered names, and disclose the excluded weight. */
  coverage_min: number;
  /** A peer set smaller than this renders "set too small to rank" instead of percentiles. */
  peer_min_size: number;
  /** Number of style twins surfaced (nearest neighbors by style vector, excl. self). */
  twins_k: number;
  /** Relative weights of the five style-vector components before cosine similarity. */
  style_vector: { sectorMix: number; sizeBand: number; top10: number; turnover: number; tenure: number };
  /** Book-snapshot default rows = min(book_rows_max, positions covering book_pct_cap%). */
  book_rows_max: number;
  book_pct_cap: number;
  /** A name counts as a "differentiated idea" only above this weight (bps of book). */
  diff_ideas_min_bps: number;
  /** Rank-migration lookback (quarters) for the tail-shape / incubation-bench note. */
  rank_migration_window: number;
  /** "Incubation bench" copy fires when ≥ this many current top-10 names began in the tail. */
  incubation_min: number;
  /** fund_quality_weight = f(clone_alpha): bounded multiplier, neutral 1.0 at 0 alpha and
   *  when alpha is unknown (new funds are never penalized). `alpha_at_max` is the
   *  annualized excess (fraction) at which the multiplier saturates to `max`. */
  fund_quality_weight: { min: number; max: number; alpha_at_max: number };
  /** Fund search (Part 6). */
  search_max_results: number;
  search_recent_k: number;
}

export const FUND_OVERVIEW_CONFIG: FundOverviewConfig = {
  /** SPY total-return proxy (Yahoo adjClose is dividend-reinvested). */
  benchmark_symbol: "SPY",

  /** Turnover bands (%/q): the less a fund trades between snapshots, the closer the
   *  snapshot estimate tracks the real long book. HIGH < 25 · MED 25–45 · LOW > 45. */
  return_conf_bands: { high: 25, med: 45 },

  /** Below 85% covered book value, the snapshot return is renormalized over covered
   *  names and the excluded weight is disclosed. */
  coverage_min: 85,

  /** Percentiles need at least 5 funds in the set to be meaningful. */
  peer_min_size: 5,

  /** Top 10 nearest style neighbors. */
  twins_k: 10,

  /** Style-vector component weights (sum need not be 1; scales the z-scored vector
   *  before cosine similarity). Equal-weight default. */
  style_vector: { sectorMix: 1, sizeBand: 1, top10: 1, turnover: 1, tenure: 1 },

  /** Show at most 20 rows, or fewer if 75% of the book is covered sooner. */
  book_rows_max: 20,
  book_pct_cap: 75,

  /** A genuinely differentiated bet is held at ≥ 25 bps (0.25% of book). */
  diff_ideas_min_bps: 25,

  /** Rank migration looks back 8 quarters; incubation-bench copy needs ≥ 3 risers. */
  rank_migration_window: 8,
  incubation_min: 3,

  /** Clone-alpha → quality multiplier. Neutral 1.0 at 0; saturates to 1.4 at +5%/yr
   *  excess and 0.6 at −5%/yr. Bounded so a few lucky funds cannot dominate the
   *  leaderboard's per-fund vote weighting. */
  fund_quality_weight: { min: 0.6, max: 1.4, alpha_at_max: 0.05 },

  search_max_results: 8,
  search_recent_k: 5,
};
