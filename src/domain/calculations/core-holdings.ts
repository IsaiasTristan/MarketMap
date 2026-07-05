/**
 * Core Holdings (Part 3) — pure, DB-free.
 *
 * Surfaces long-held, high-conviction names that carry no flow signal (so the
 * leaderboard/trajectory/rotation views gate them out) via FUND-RELATIVE tenure:
 * a 4-quarter hold means conviction at a fund that churns every 1-2 quarters and
 * nothing at a fund that holds for years. There is no fixed-quarter gate.
 *
 *   tenure(f,t)      consecutive quarters f has held t (left-censored at the
 *                    earliest ingested quarter → true tenure is longer, "≥N")
 *   median_tenure(f) median tenure across f's current book (censored → floor N)
 *   tenure_mult(f,t) tenure / median_tenure(f)
 *   long-hold vote   tenure_mult ≥ long_hold_mult AND weight ≥ min_entry_bps
 *   endorsement(t)   Σ over long-hold voters of
 *                      min(tenure_mult, cap) × weight_bps × fund_quality_weight
 *   validity         ≥ min_long_hold_voters AND ≥ min_categories distinct cats
 *   stasis-break     a qualified trim/exit by a tenure_mult ≥ long_hold_mult
 *                    holder; significance scales with the DEPARTING tenure_mult
 *
 * All thresholds live in CORE_HOLDINGS_CONFIG.
 */

export interface CoreHoldingsConfig {
  /** |share change| within this % is continuity/dust (does not reset tenure and
   *  is not a qualified trim for a stasis-break). */
  tenure_deadzone_pct: number;
  /** tenure_mult at/above which a holder is a long-hold voter. */
  long_hold_mult: number;
  /** Minimum position weight (bps of book) to cast a long-hold vote. */
  min_entry_bps: number;
  /** Board validity gate: minimum long-hold voters. */
  min_long_hold_voters: number;
  /** Board validity gate: minimum distinct fund categories among voters. */
  min_categories: number;
  /** Board size. */
  core_board_size: number;
  /** tenure_mult is capped here in the endorsement sum. */
  tenure_mult_cap: number;
  /** fund_quality_weight for elite (isMostRespected) funds. */
  elite_quality_weight: number;
  /** fund_quality_weight for non-elite signal funds. */
  base_quality_weight: number;
  /** If more than this fraction of a fund's book tenures are censored, its median
   *  tenure is flagged a floor estimate. */
  censored_floor_flag_pct: number;
  /** More than this fraction of a fund's prior-quarter book vanishing in one
   *  quarter is a suspicious full-book reset (possible CIK migration) → "verify". */
  suspicious_book_reset_pct: number;

  // ── Name-level stasis-break (v3 Part 0). ────────────────────────────────────
  // A stasis break is NOT one holder among many trimming — for a widely-held name
  // ≥1 long holder trims every quarter, so that fires perpetually (~490/qtr). It is
  // this quarter's long-hold DEPARTURE INTENSITY being anomalous vs the name's OWN
  // trailing baseline (same shape as the leaderboard's Distribution-Watch severity),
  // so it is rare (0-3/normal quarter) and name-specific.
  /** Trailing window (quarters) for the name's own long-hold-departure baseline. */
  stasis_baseline_window: number;
  /** Minimum baseline observations to compute severity (else UNKNOWN → no break). */
  stasis_min_baseline_n: number;
  /** Fire only when this-quarter departure severity (z vs the name's own baseline)
   *  is at/above this. */
  stasis_severity_min: number;
  /** ...AND at least this fraction of the name's long-hold base departed this
   *  quarter (absolute materiality floor, so a low-baseline name can't fire on one
   *  holder). */
  stasis_min_departure_frac: number;
  /** A name must have at least this many KNOWN long-hold voters entering the quarter
   *  for a break to be a NAME-level signal (1-2 voter names departing is a per-fund
   *  event, not the name's stasis breaking). */
  stasis_min_base: number;
  /** A long-hold voter whose fund did not file this quarter is UNKNOWN, not a
   *  reducer — excluded from the intensity num/denom; the name flags "partial data"
   *  rather than a break. */
  stasis_unknown_skip: boolean;
  /** If more than this fraction of the prior long-hold base is UNKNOWN (funds that
   *  did not file), the intensity is unreliable → suppress the break, flag partial. */
  stasis_unknown_max_frac: number;
}

export const CORE_HOLDINGS_CONFIG: CoreHoldingsConfig = {
  tenure_deadzone_pct: 10,
  long_hold_mult: 1.5,
  min_entry_bps: 25,
  min_long_hold_voters: 5,
  min_categories: 2,
  core_board_size: 25,
  tenure_mult_cap: 4.0,
  elite_quality_weight: 1.5,
  base_quality_weight: 1.0,
  censored_floor_flag_pct: 0.3,
  suspicious_book_reset_pct: 0.5,
  stasis_baseline_window: 8,
  stasis_min_baseline_n: 4,
  stasis_severity_min: 2.0,
  stasis_min_departure_frac: 0.15,
  stasis_min_base: 3,
  stasis_unknown_skip: true,
  stasis_unknown_max_frac: 0.5,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function median(vals: number[]): number {
  const s = [...vals].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface TenurePoint {
  tenure: number;
  censored: boolean;
}

/**
 * Per-quarter tenure for one (fund, ticker) from a held-flag array aligned to the
 * GLOBAL period list (index 0 = earliest ingested quarter). tenure = consecutive
 * held quarters ending at each index; censored when the run reaches index 0 (the
 * earliest quarter is baselined HELD, so the true start is unknowable). A fund
 * that first appears mid-history has a real NEW there, so it is not censored.
 * Amendments never reach here (ingest merges to one row per (fund,ticker,period)).
 */
export function tenureSeries(held: boolean[]): TenurePoint[] {
  const out: TenurePoint[] = [];
  let run = 0;
  let runStart = -1;
  for (let i = 0; i < held.length; i++) {
    if (held[i]) {
      if (run === 0) runStart = i;
      run += 1;
    } else {
      run = 0;
      runStart = -1;
    }
    out.push({ tenure: run, censored: run > 0 && runStart === 0 });
  }
  return out;
}

/**
 * Median tenure over a fund's current book. Censored tenures contribute their
 * floor value N (we know it is ≥ N). floorEstimate flags that > censored_floor_flag_pct
 * of the book is censored, so the median is itself a floor.
 */
export function fundMedianTenure(
  book: TenurePoint[],
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): { median: number; floorEstimate: boolean } {
  if (book.length === 0) return { median: 0, floorEstimate: false };
  const med = median(book.map((b) => b.tenure));
  const censoredFrac = book.filter((b) => b.censored).length / book.length;
  return { median: med, floorEstimate: censoredFrac > config.censored_floor_flag_pct };
}

/** tenure_mult = tenure / median_tenure(f). 0 when the fund median is non-positive. */
export function tenureMult(tenure: number, fundMedian: number): number {
  if (!(fundMedian > 0)) return 0;
  return round2(tenure / fundMedian);
}

export interface Voter {
  fundId: string;
  tenure: number;
  censored: boolean;
  tenureMult: number;
  /** Position weight in bps of the fund's book. */
  weightBps: number;
  isElite: boolean;
  category: string;
  /** fund_quality_weight = f(clone_alpha) (Fund Overview Part 1). When provided, it
   *  REPLACES the interim elite-binary weight; a neutral 1.0 (new/insufficient-history
   *  funds) is a no-op. Absent → fall back to the elite-binary weight. */
  qualityWeight?: number;
}

/** A holder qualifies as a long-hold voter. */
export function isLongHoldVote(v: Voter, config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG): boolean {
  return v.tenureMult >= config.long_hold_mult && v.weightBps >= config.min_entry_bps;
}

export interface EndorsementResult {
  endorsementScore: number;
  longHoldVoters: number;
  distinctCategories: number;
  eliteVoters: number;
  /** Median / mean tenure across the long-hold voters (quarters). */
  medianTenure: number | null;
  avgTenure: number | null;
  /** Fraction of long-hold voter tenures that are left-censored. */
  censoredPct: number;
  /** Passed BOTH validity gates (≥ voters AND ≥ categories). */
  valid: boolean;
  /** Per-voter decomposition for the endorsement-bar tooltip. */
  contributions: Array<{ fundId: string; contribution: number; tenureMult: number; weightBps: number; isElite: boolean }>;
}

/**
 * Endorsement score for one name from all its current holders (only long-hold
 * voters contribute). fund_quality_weight prefers the computed clone-alpha weight
 * (Fund Overview Part 1) when a voter carries one, else falls back to the interim
 * elite-binary weight (Part 3c decision).
 */
export function scoreEndorsement(
  holders: Voter[],
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): EndorsementResult {
  const voters = holders.filter((h) => isLongHoldVote(h, config));
  const contributions = voters.map((v) => {
    const qualityWeight = v.qualityWeight ?? (v.isElite ? config.elite_quality_weight : config.base_quality_weight);
    const contribution = round2(Math.min(v.tenureMult, config.tenure_mult_cap) * v.weightBps * qualityWeight);
    return { fundId: v.fundId, contribution, tenureMult: v.tenureMult, weightBps: v.weightBps, isElite: v.isElite };
  });
  const endorsementScore = round2(contributions.reduce((a, c) => a + c.contribution, 0));
  const categories = new Set(voters.map((v) => v.category));
  const eliteVoters = voters.filter((v) => v.isElite).length;
  const censoredPct = voters.length ? round2(voters.filter((v) => v.censored).length / voters.length) : 0;
  return {
    endorsementScore,
    longHoldVoters: voters.length,
    distinctCategories: categories.size,
    eliteVoters,
    medianTenure: voters.length ? median(voters.map((v) => v.tenure)) : null,
    avgTenure: voters.length ? round2(voters.reduce((a, v) => a + v.tenure, 0) / voters.length) : null,
    censoredPct,
    valid: voters.length >= config.min_long_hold_voters && categories.size >= config.min_categories,
    contributions,
  };
}

/**
 * A qualified trim or exit: an exit, or a share reduction beyond the tenure
 * deadzone. Small dribbles (within deadzone) are dust and do not qualify.
 */
export function isQualifiedTrimOrExit(
  prevShares: number,
  curShares: number,
  exited: boolean,
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): boolean {
  if (exited || curShares <= 0) return true;
  if (!(prevShares > 0)) return false;
  const changePct = ((curShares - prevShares) / prevShares) * 100;
  return changePct <= -config.tenure_deadzone_pct;
}

/**
 * Per-holder stasis significance, scaled by the DEPARTING fund's tenure_mult.
 * Retained for the per-fund drill copy / fund-attribution; the NAME-level event
 * fire decision and significance are the baseline-relative functions below.
 */
export function stasisBreakSignificance(
  departingTenureMult: number,
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): number {
  return round2(Math.min(departingTenureMult, config.tenure_mult_cap) / config.tenure_mult_cap);
}

// ── Name-level stasis break (v3 Part 0). ──────────────────────────────────────

/** One quarter's classification of a name's entering long-hold base. */
export interface StasisQuarterObs {
  /** Long-hold voters that qualified LAST quarter and whose status this quarter is
   *  KNOWN (their fund filed). Denominator of the departure intensity. */
  priorLongHolders: number;
  /** Of the known base, how many did a qualified trim/exit this quarter. */
  departed: number;
  /** Long-hold voters whose fund did not file this quarter (UNKNOWN, skipped). */
  unknown: number;
}

/**
 * Fraction of the name's KNOWN long-hold base that departed this quarter (0-1), or
 * null when there is no classifiable base (all-unknown or none entering). UNKNOWN
 * holders are already excluded from priorLongHolders (see stasis_unknown_skip).
 */
export function longHoldDepartureIntensity(obs: StasisQuarterObs): number | null {
  if (!(obs.priorLongHolders > 0)) return null;
  return round2(obs.departed / obs.priorLongHolders);
}

export interface StasisSeverity {
  /** z-score of current intensity vs the name's own trailing baseline; null when
   *  the baseline is too thin or has zero variance. */
  severity: number | null;
  mean: number | null;
  sd: number | null;
  n: number;
}

/**
 * Severity of this quarter's departure intensity vs the name's OWN trailing
 * baseline (mirrors the Distribution-Watch churn severity). A mega-cap that churns
 * a third of its long holders every quarter has a HIGH baseline, so a normal
 * quarter scores ~0σ and does not fire — only a genuine spike does.
 */
export function stasisSeverity(
  current: number,
  baseline: number[],
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): StasisSeverity {
  const vals = baseline.filter((v) => Number.isFinite(v));
  if (vals.length < config.stasis_min_baseline_n) return { severity: null, mean: null, sd: null, n: vals.length };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const severity = sd > 1e-6 ? round2((current - mean) / sd) : null;
  return { severity, mean: round2(mean), sd: round2(sd), n: vals.length };
}

/**
 * A NAME-level stasis break fires only when this quarter's long-hold departure is
 * BOTH anomalous vs the name's own baseline (severity ≥ min) AND materially large
 * (intensity ≥ floor). Either condition alone is insufficient — a 3σ move off a
 * near-zero base is noise; a large-but-typical churn is business as usual.
 */
export function isNameStasisBreak(
  intensity: number | null,
  severity: number | null,
  priorLongHolders: number,
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): boolean {
  if (intensity == null || severity == null) return false;
  if (priorLongHolders < config.stasis_min_base) return false;
  return severity >= config.stasis_severity_min && intensity >= config.stasis_min_departure_frac;
}

/**
 * Event significance 0-1 for a fired name-level break, mapped from severity so the
 * threshold (stasis_severity_min) lands at 0.75 and severity_min+2σ saturates at 1.
 * Keeps the core board's "significance ≥ 0.75 = shown" contract meaningful.
 */
export function nameStasisSignificance(
  severity: number,
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): number {
  return round2(Math.max(0, Math.min(1, 0.75 + (severity - config.stasis_severity_min) * 0.125)));
}
