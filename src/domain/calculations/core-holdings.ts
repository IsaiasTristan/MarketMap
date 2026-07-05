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
 * Stasis-break significance, scaled by the DEPARTING fund's tenure_mult (a deeper
 * long-term holder trimming is more notable). Normalized 0-1 against the cap.
 */
export function stasisBreakSignificance(
  departingTenureMult: number,
  config: CoreHoldingsConfig = CORE_HOLDINGS_CONFIG,
): number {
  return round2(Math.min(departingTenureMult, config.tenure_mult_cap) / config.tenure_mult_cap);
}
