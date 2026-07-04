/**
 * Flow Trajectory — the single accumulation-series + pattern-ranking core.
 *
 * THE one implementation of the cumulative accumulation series (Part 1a): a
 * running sum of each quarter's DRIFT-ADJUSTED active weight measured over ALL
 * signal-tier funds (non-holders contribute 0). That per-quarter input is the
 * leaderboard's `netflowBps` (= computeActiveFlowPair's `netBpsAllFunds`), NOT
 * the participant-only `activeBpsAvg`. Both the leaderboard and the trajectory
 * views import `cumulativeAccSeries` from here — there is no second cumsum.
 *
 * Pattern ranking (Part 1c) is a pure function of the SHAPE of that series and
 * the breadth trend — never the latest-quarter move:
 *
 *   rank = streak_length × slope_consistency × breadth_growth_factor
 *
 * Pure, DB-free, deterministic (mirrors flow-leaderboard.ts). All tunables live
 * in FLOW_TRAJECTORY_CONFIG.
 */

export interface FlowTrajectoryConfig {
  /** Per-quarter |active move| (bps, all-funds denominator) at/below which the
   *  series is rebalancing dust. Re-baselined DOWN from the participant-only
   *  floor (2 bps): dividing the same Σ deltaBps by ALL evaluated funds (~135)
   *  rather than the handful of holders shrinks each step ~5-15×. Tune against
   *  the live stage census (Part 2 acceptance check). */
  noise_floor_bps: number;
  /** Streak length (consecutive same-signed accumulation quarters) at/above
   *  which a build can be DURABLE. */
  durable_min_streak: number;
  /** Minimum slope consistency (R² of the acc series over the streak window)
   *  for a build to read as a staircase rather than a whipsaw. */
  durable_min_r2: number;
  /** Clamp on the breadth-growth factor. */
  breadth_growth_clamp: readonly [number, number];
}

export const FLOW_TRAJECTORY_CONFIG: FlowTrajectoryConfig = {
  noise_floor_bps: 0.5,
  durable_min_streak: 4,
  durable_min_r2: 0.7,
  breadth_growth_clamp: [0.5, 2.5],
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Cumulative accumulation series (Part 1a). Running sum of each quarter's
 * all-signal-funds net active weight (bps). Input is ascending by period; a
 * non-finite quarter contributes 0 (a missing quarter isn't a reversal).
 * THE single acc-series implementation — every read path calls this.
 */
export function cumulativeAccSeries(perQuarterNetBps: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  let cum = 0;
  for (const b of perQuarterNetBps) {
    cum += typeof b === "number" && Number.isFinite(b) ? b : 0;
    out.push(round2(cum));
  }
  return out;
}

/**
 * Coefficient of determination R² of the series values against a linear fit
 * over the inclusive index window [start, end]. Staircase → 1, whipsaw → 0.
 * Returns 0 for < 3 finite points or zero variance in either axis.
 */
export function rSquared(series: number[], start = 0, end = series.length - 1): number {
  const ys: number[] = [];
  for (let i = Math.max(0, start); i <= Math.min(series.length - 1, end); i++) {
    if (Number.isFinite(series[i])) ys.push(series[i]!);
  }
  const n = ys.length;
  if (n < 3) return 0;
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(0, Math.min(1, r * r));
}

/**
 * Breadth growth factor: 1 + (holders_now − holders_start)/max(holders_start,3),
 * clamped to config.breadth_growth_clamp. A build whose holder base widened
 * scores up; one that narrowed scores down.
 */
export function breadthGrowthFactor(
  holdersStart: number,
  holdersNow: number,
  config: FlowTrajectoryConfig = FLOW_TRAJECTORY_CONFIG,
): number {
  const raw = 1 + (holdersNow - holdersStart) / Math.max(holdersStart, 3);
  const [lo, hi] = config.breadth_growth_clamp;
  return Math.max(lo, Math.min(hi, raw));
}

/**
 * Signed accumulation streak from the per-quarter all-funds net-bps series:
 * consecutive quarters (ending at the latest) whose active move is above the
 * noise floor AND matches the latest quarter's sign. A flat/noise quarter
 * (|move| ≤ noise_floor) is NOT accumulation and BREAKS the run — so a lone
 * jump after flat quarters is streak 1 (a spike), and a plateau ends the run.
 * Returns +N accumulating, −N distributing, 0 when the latest quarter is flat.
 * (Share-count "dividend dribble" tolerance is a Part 3 tenure concern, not this
 * bps streak.)
 */
export function accumulationStreak(
  perQuarterNetBps: number[],
  config: FlowTrajectoryConfig = FLOW_TRAJECTORY_CONFIG,
): number {
  const n = perQuarterNetBps.length;
  if (n === 0) return 0;
  const sgn = (x: number): number =>
    x > config.noise_floor_bps ? 1 : x < -config.noise_floor_bps ? -1 : 0;
  const latest = sgn(perQuarterNetBps[n - 1] ?? 0);
  if (latest === 0) return 0;
  let streak = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (sgn(perQuarterNetBps[i] ?? 0) !== latest) break; // opposite sign OR flat ends the run
    streak += 1;
  }
  return latest * streak;
}

export interface TrajectoryRankInput {
  /** Ascending cumulative accumulation series (from cumulativeAccSeries). */
  accSeries: number[];
  /** Signed streak length; magnitude is the # of consecutive same-signed
   *  accumulation quarters ending at the latest period. */
  streakLength: number;
  /** Holder count at the START of the streak window. */
  holdersStart: number;
  /** Holder count at the latest period. */
  holdersNow: number;
}

/**
 * Pattern rank score (Part 1c) = streak_length × slope_consistency ×
 * breadth_growth_factor. slope_consistency is the R² of the acc series over the
 * streak window (the last streakLength+1 points). NEVER a function of the
 * latest-quarter move — a lone spike (streak 1) is capped by its streak length
 * no matter how large the jump.
 */
export function trajectoryRankScore(
  input: TrajectoryRankInput,
  config: FlowTrajectoryConfig = FLOW_TRAJECTORY_CONFIG,
): number {
  const streak = Math.abs(input.streakLength);
  if (streak <= 0) return 0;
  const start = Math.max(0, input.accSeries.length - (streak + 1));
  const slope = rSquared(input.accSeries, start, input.accSeries.length - 1);
  const bgf = breadthGrowthFactor(input.holdersStart, input.holdersNow, config);
  return round2(streak * slope * bgf);
}
