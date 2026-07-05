/**
 * Fresh calls feed (FUNDS Part 3) — pure ranking core, DB-free.
 *
 * A fresh call = a qualified initiation that is PENDING (window not yet elapsed) with
 * ZERO follow votes so far — an originator's call before anyone has confirmed it.
 * Expiry is definitional: a call leaves the feed the moment it gains a follower
 * (promoted to the leaderboard/trajectory reads) or ages past the follow window
 * (archived as not-followed → feeds the rate). So `isFreshCall` is the single gate.
 *
 * Ranking = originator follow_rate × initiation_strength (sizing mult). Funds below
 * min_n_for_rate can't show a real rate, so they fall back to
 * cohort_median_rate × fresh_lown_discount and carry a "low-n originator" flag.
 */
import type { FollowStatus } from "@/domain/calculations/follow-attribution";
import type { FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";

export interface FreshCallCandidate {
  fundId: string;
  ticker: string;
  sector: string | null;
  /** initiation_strength = min(sizing_mult, cap). */
  strength: number;
  status: FollowStatus;
  followerFunds: number;
  ageQuarters: number;
}

/** A candidate is a fresh call iff it is pending AND has drawn no follow vote yet. */
export function isFreshCall(c: Pick<FreshCallCandidate, "status" | "followerFunds">): boolean {
  return c.status === "pending" && c.followerFunds === 0;
}

export interface FreshCallRankInput extends FreshCallCandidate {
  originatorFollowRate: number | null;
  originatorRateSufficient: boolean;
}

export interface RankedFreshCall extends FreshCallRankInput {
  /** Rate used in the rank (real rate, or the low-n cohort fallback). */
  effectiveRate: number;
  rankScore: number;
  lowN: boolean;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Rank the fresh calls. Deterministic: sort by rankScore desc, then strength desc,
 * then ticker. Non-fresh candidates are dropped (expiry). `cohortMedianRate` is the
 * median follow rate across funds with a sufficient rate (may be null → 0).
 */
export function rankFreshCalls(
  inputs: FreshCallRankInput[],
  cohortMedianRate: number | null,
  config: FundsAttributionConfig,
): RankedFreshCall[] {
  const fallback = (cohortMedianRate ?? 0) * config.fresh_lown_discount;
  return inputs
    .filter((c) => isFreshCall(c))
    .map((c): RankedFreshCall => {
      const lowN = !c.originatorRateSufficient || c.originatorFollowRate == null;
      const effectiveRate = lowN ? fallback : c.originatorFollowRate!;
      return { ...c, effectiveRate: round4(effectiveRate), rankScore: round4(effectiveRate * c.strength), lowN };
    })
    .sort((a, b) => b.rankScore - a.rankScore || b.strength - a.strength || a.ticker.localeCompare(b.ticker));
}
