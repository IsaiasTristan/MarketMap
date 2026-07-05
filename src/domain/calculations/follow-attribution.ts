/**
 * Follow attribution (FUNDS Part 1) — pure, DB-free.
 *
 * Treats the FUND as the unit: which funds ORIGINATE positions that others later
 * follow. The design is deliberately ASYMMETRIC:
 *
 *   ORIGINATOR — must clear the full qualified-initiation bar (≥ min_entry_bps AND
 *                ≥ min_sizing_mult, with the first-filing / gap / min-positions
 *                guards). These are the `originators` (the precomputed
 *                FundHoldingSnapshot.initiationStrength events, signal-tier).
 *   FOLLOW VOTE — only needs a NEW position ≥ follow_min_bps (a materiality floor,
 *                no sizing-multiple gate). A late fund confirming the call with even
 *                a modestly sized starter position counts; sub-floor dust does not.
 *                These are the `followers` pool (all signal-tier NEW positions that
 *                clear the floor — a superset that includes the qualified originators).
 *
 * The asymmetry IS the product: a strict bar for the caller, a materiality bar for
 * confirmation. The sizing multiple stays a WEIGHT downstream (cluster strength /
 * significance), never a follower gate.
 *
 *   FOLLOWED           ≥ follow_min_funds DISTINCT signal funds cast a follow vote in
 *                      t within (q0, q0+follow_window]. Same-q0 co-originators and the
 *                      originator itself never count (the window excludes q0).
 *                      lead = first-follower qtr − q0.
 *   CONSENSUS_AT_BIRTH ≥ follow_min_funds QUALIFIED ORIGINATORS at q0 itself → nobody
 *                      led; excluded from every rate. (Keys off ORIGINATOR
 *                      qualification, not the follower definition.)
 *   PENDING            window not yet fully elapsed as-of the eval quarter and not yet
 *                      followed → excluded from rates; surfaced as a fresh call.
 *   NOT_FOLLOWED       window elapsed with < follow_min_funds follow votes.
 *
 * No-lookahead: only events whose `availableQuarter` ≤ asOf are visible (filing-date
 * basis). Determinism: fixed (fundId, ticker, quarter) sort tiebreaks.
 */
import type { FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";

export type FollowStatus = "followed" | "not_followed" | "pending" | "consensus_at_birth";

/** One qualified initiation (the ORIGINATOR bar; gated signal-tier + qualified upstream). */
export interface Initiation {
  fundId: string;
  ticker: string;
  /** Global quarter index (ascending, 0 = earliest ingested quarter). */
  quarter: number;
  /** initiation_strength = min(sizing_mult, cap). */
  strength: number;
  /** The ticker's sector (for the fund's best-sector aggregate). */
  sector: string | null;
  /** Quarter by which the filing was public (filing-date basis). Defaults to `quarter`. */
  availableQuarter?: number;
  /** Forward return after entry (filing-date basis), fraction. Loader-supplied. */
  fwd1q?: number | null;
  fwd2q?: number | null;
}

/** One follow-vote candidate: a signal-tier NEW position ≥ follow_min_bps of book. */
export interface FollowerVote {
  fundId: string;
  ticker: string;
  quarter: number;
  /** NEW position weight, bps of book (already filtered to ≥ follow_min_bps by the loader,
   *  but re-checked here so the core is self-contained and testable). */
  entryBps: number;
  availableQuarter?: number;
}

export interface InitiationOutcome {
  fundId: string;
  ticker: string;
  quarter: number;
  strength: number;
  sector: string | null;
  status: FollowStatus;
  /** Distinct follow-vote funds observed so far within the (capped) window. */
  followerFunds: number;
  /** Quarters to the first follow vote; null unless followed. */
  lead: number | null;
  /** Quarters observable after q0 (asOf − q0). */
  age: number;
}

export interface FundFollowStats {
  fundId: string;
  n: number;
  followed: number;
  followRate: number | null;
  medianLead: number | null;
  fwd1q: number | null;
  fwd2q: number | null;
  hitRate2q: number | null;
  bestSector: string | null;
  bestSectorRate: number | null;
  trendRecent: number | null;
  trendPrior: number | null;
  rateSufficient: boolean;
}

export interface FollowAttribution {
  outcomes: InitiationOutcome[];
  funds: FundFollowStats[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(vals: number[]): number | null {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const availOf = (i: { quarter: number; availableQuarter?: number }): number => i.availableQuarter ?? i.quarter;

function rateOf(outcomes: InitiationOutcome[]): { rate: number | null; n: number; followed: number } {
  const resolved = outcomes.filter((o) => o.status === "followed" || o.status === "not_followed");
  const followed = resolved.filter((o) => o.status === "followed").length;
  return { rate: resolved.length ? round4(followed / resolved.length) : null, n: resolved.length, followed };
}

/**
 * Classify every qualified initiation as-of `asOf` (default: the latest quarter),
 * using the separate follower-vote pool, then aggregate per fund over the trailing
 * stat_window. Pure + deterministic.
 */
export function computeFollowAttribution(
  originators: Initiation[],
  followers: FollowerVote[],
  config: FundsAttributionConfig,
  asOf?: number,
): FollowAttribution {
  const maxQuarter =
    asOf ??
    Math.max(
      originators.reduce((m, i) => Math.max(m, i.quarter), 0),
      followers.reduce((m, f) => Math.max(m, f.quarter), 0),
    );

  // No-lookahead: only filings public as-of the eval quarter.
  const orig = originators
    .filter((i) => availOf(i) <= maxQuarter)
    .slice()
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.quarter - b.quarter || a.fundId.localeCompare(b.fundId));

  // Follow-vote pool: visible + clears the materiality floor.
  const votes = followers.filter((f) => availOf(f) <= maxQuarter && f.entryBps >= config.follow_min_bps);
  const votesByTicker = new Map<string, FollowerVote[]>();
  for (const v of votes) (votesByTicker.get(v.ticker) ?? votesByTicker.set(v.ticker, []).get(v.ticker)!).push(v);

  // Qualified originators per ticker (for co-origination / consensus, which key off
  // ORIGINATOR qualification only).
  const origByTicker = new Map<string, Initiation[]>();
  for (const i of orig) (origByTicker.get(i.ticker) ?? origByTicker.set(i.ticker, []).get(i.ticker)!).push(i);

  const outcomes: InitiationOutcome[] = [];
  for (const i of orig) {
    const q0 = i.quarter;
    const coOriginators = new Set(origByTicker.get(i.ticker)!.filter((p) => p.quarter === q0).map((p) => p.fundId));
    const consensus = coOriginators.size >= config.follow_min_funds;

    const windowEnd = Math.min(q0 + config.follow_window, maxQuarter);
    const followerFundsSet = new Set<string>();
    let firstFollowerQ: number | null = null;
    for (const v of votesByTicker.get(i.ticker) ?? []) {
      if (v.quarter > q0 && v.quarter <= windowEnd && !coOriginators.has(v.fundId) && v.fundId !== i.fundId) {
        followerFundsSet.add(v.fundId);
        if (firstFollowerQ === null || v.quarter < firstFollowerQ) firstFollowerQ = v.quarter;
      }
    }
    const followerFunds = followerFundsSet.size;
    const age = maxQuarter - q0;
    const followed = followerFunds >= config.follow_min_funds;

    let status: FollowStatus;
    let lead: number | null = null;
    if (consensus) status = "consensus_at_birth";
    else if (followed) {
      status = "followed";
      lead = firstFollowerQ !== null ? firstFollowerQ - q0 : null;
    } else if (age < config.follow_window) status = "pending";
    else status = "not_followed";

    outcomes.push({ fundId: i.fundId, ticker: i.ticker, quarter: q0, strength: i.strength, sector: i.sector, status, followerFunds, lead, age });
  }

  // ── Per-fund aggregation over the trailing stat_window. ──
  const windowStart = maxQuarter - config.stat_window + 1;
  const initByKey = new Map<string, Initiation>();
  for (const i of orig) initByKey.set(`${i.fundId}|${i.ticker}|${i.quarter}`, i);

  const byFund = new Map<string, InitiationOutcome[]>();
  for (const o of outcomes) {
    if (o.quarter < windowStart) continue;
    (byFund.get(o.fundId) ?? byFund.set(o.fundId, []).get(o.fundId)!).push(o);
  }

  const funds: FundFollowStats[] = [];
  for (const [fundId, os] of byFund) {
    const { rate, n, followed } = rateOf(os);
    const leads = os.filter((o) => o.status === "followed" && o.lead !== null).map((o) => o.lead!);

    const fwd1s: number[] = [];
    const fwd2s: number[] = [];
    for (const o of os) {
      const src = initByKey.get(`${o.fundId}|${o.ticker}|${o.quarter}`);
      if (src?.fwd1q != null && Number.isFinite(src.fwd1q)) fwd1s.push(src.fwd1q);
      if (src?.fwd2q != null && Number.isFinite(src.fwd2q)) fwd2s.push(src.fwd2q);
    }
    const mean = (xs: number[]): number | null => (xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

    const bySector = new Map<string, InitiationOutcome[]>();
    for (const o of os) {
      if (o.sector == null) continue;
      (bySector.get(o.sector) ?? bySector.set(o.sector, []).get(o.sector)!).push(o);
    }
    let bestSector: string | null = null;
    let bestSectorRate: number | null = null;
    for (const [sector, so] of [...bySector.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const r = rateOf(so);
      if (r.n >= config.sector_min_n && r.rate !== null && (bestSectorRate === null || r.rate > bestSectorRate)) {
        bestSector = sector;
        bestSectorRate = r.rate;
      }
    }

    const recent = rateOf(os.filter((o) => o.quarter > maxQuarter - 4));
    const prior = rateOf(os.filter((o) => o.quarter <= maxQuarter - 4 && o.quarter > maxQuarter - 8));

    funds.push({
      fundId,
      n,
      followed,
      followRate: rate,
      medianLead: median(leads),
      fwd1q: mean(fwd1s),
      fwd2q: mean(fwd2s),
      hitRate2q: fwd2s.length ? round4(fwd2s.filter((x) => x > 0).length / fwd2s.length) : null,
      bestSector,
      bestSectorRate,
      trendRecent: recent.n ? recent.rate : null,
      trendPrior: prior.n ? prior.rate : null,
      rateSufficient: n >= config.min_n_for_rate,
    });
  }
  funds.sort((a, b) => a.fundId.localeCompare(b.fundId));

  return { outcomes, funds };
}
