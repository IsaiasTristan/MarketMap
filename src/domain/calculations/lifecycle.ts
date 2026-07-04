/**
 * Lifecycle classifier (Part 2) — pure, DB-free.
 *
 * Maps a name's accumulation history to one stage per quarter, from the SAME
 * cumulative accumulation series the rest of Engine 3 reads (flow-trajectory's
 * cumulativeAccSeries over all-signal-funds net bps). One implementation:
 * `classifyLifecycleSeries` folds the whole history so per-quarter transitions
 * (BROKEN once, CORE graduation) are derived deterministically from the prefix
 * — there is no second per-quarter classifier.
 *
 * Stages:
 *   SPIKE    streak == 1 with |latest move| ≥ spike_floor_bps
 *   FORMING  streak 2-3
 *   DURABLE  streak ≥ durable_min_streak AND slope_consistency ≥ durable_min_r2
 *   CORE     graduates from a DURABLE build once accumulation plateaus
 *            (|move| < core_deadzone_bps for core_min_plateau_qtrs consecutive
 *            quarters) while the acc level is retained ≥ core_retained_pct of peak
 *   BROKEN   first net-negative quarter after a positive streak ≥ broken_min_streak
 *            (a one-time event; the next quarter reclassifies normally)
 *   null     none of the above (choppy / flat / distributing)
 *
 * CROWDED is an escalation FLAG (not a stage): set when breadth crosses the
 * cross-sectional p75 that quarter; it rides alongside the underlying stage and
 * hands off to the scatter.
 */
import { accumulationStreak, cumulativeAccSeries, rSquared, FLOW_TRAJECTORY_CONFIG } from "./flow-trajectory";

export type LifecycleStage = "SPIKE" | "FORMING" | "DURABLE" | "CORE" | "BROKEN";

export interface LifecycleConfig {
  /** |latest move| (bps) a lone-quarter build must clear to read as a SPIKE. */
  spike_floor_bps: number;
  /** Streak length at/above which a build can be DURABLE. */
  durable_min_streak: number;
  /** Minimum slope consistency (R²) over the build window for DURABLE. */
  durable_min_r2: number;
  /** |move| (bps) at/below which a quarter counts as a plateau step. */
  core_deadzone_bps: number;
  /** Consecutive plateau quarters required to graduate DURABLE → CORE. */
  core_min_plateau_qtrs: number;
  /** Fraction of peak acc level that must be retained to stay CORE. */
  core_retained_pct: number;
  /** Prior positive streak length required for a negative quarter to be BROKEN. */
  broken_min_streak: number;
}

export const LIFECYCLE_CONFIG: LifecycleConfig = {
  spike_floor_bps: 3,
  durable_min_streak: 4,
  durable_min_r2: 0.7,
  core_deadzone_bps: 0.5,
  core_min_plateau_qtrs: 2,
  core_retained_pct: 0.8,
  broken_min_streak: 3,
};

export interface StageInfo {
  stage: LifecycleStage | null;
  /** CROWDED escalation flag (breadth ≥ cross-sectional p75 this quarter). */
  crowded: boolean;
  /** Signed accumulation streak ending at this quarter. */
  streak: number;
}

/**
 * Classify the stage at the LAST quarter of the given prefix (per-quarter net
 * bps, ascending). Pure; derives everything from the prefix so looping it over
 * growing prefixes yields the full historical stage series.
 * `breadthAtP75` marks the CROWDED escalation for this quarter.
 */
export function classifyLifecycleAt(
  perQuarterNetBps: number[],
  breadthAtP75 = false,
  config: LifecycleConfig = LIFECYCLE_CONFIG,
): StageInfo {
  const n = perQuarterNetBps.length;
  const acc = cumulativeAccSeries(perQuarterNetBps);
  // Streak noise floor is tied to the lifecycle plateau deadzone so a "flat"
  // quarter reads the same to the streak and to the CORE plateau test.
  const streakCfg = { ...FLOW_TRAJECTORY_CONFIG, noise_floor_bps: config.core_deadzone_bps };
  const streak = accumulationStreak(perQuarterNetBps, streakCfg);
  const info = (stage: LifecycleStage | null): StageInfo => ({ stage, crowded: breadthAtP75, streak });
  if (n === 0) return info(null);

  const latest = perQuarterNetBps[n - 1] ?? 0;
  const floor = config.core_deadzone_bps;

  // BROKEN: the latest quarter is net-negative and the most recent build (looking
  // back past plateau/flat quarters, stopping at any earlier drop) reached a
  // positive run ≥ broken_min_streak. Fires once — the quarter after a break hits
  // an earlier drop when scanning back, so its build count is 0.
  if (latest < -floor && n >= 2) {
    let priorBuild = 0;
    for (let i = n - 2; i >= 0; i--) {
      const d = perQuarterNetBps[i] ?? 0;
      if (d < -floor) break; // an earlier drop already broke the prior run
      if (d > floor) priorBuild += 1; // count active-build quarters (flats are skipped)
    }
    if (priorBuild >= config.broken_min_streak) return info("BROKEN");
  }

  // CORE: a plateau of ≥ core_min_plateau_qtrs trailing flat quarters sitting on
  // top of a qualifying DURABLE build, with the acc level retained ≥ pct of peak.
  let plateauLen = 0;
  for (let i = n - 1; i >= 0 && Math.abs(perQuarterNetBps[i] ?? 0) <= floor; i--) plateauLen++;
  if (plateauLen >= config.core_min_plateau_qtrs) {
    const buildEnd = n - 1 - plateauLen; // last active-build index before the plateau
    if (buildEnd >= 0) {
      const buildStreak = accumulationStreak(perQuarterNetBps.slice(0, buildEnd + 1), streakCfg);
      const buildStart = buildEnd - (Math.abs(buildStreak) - 1);
      const slope = rSquared(acc, Math.max(0, buildStart), buildEnd);
      const peak = Math.max(...acc);
      const retained = peak > 0 ? (acc[n - 1] ?? 0) / peak : 0;
      if (buildStreak >= config.durable_min_streak && slope >= config.durable_min_r2 && retained >= config.core_retained_pct) {
        return info("CORE");
      }
    }
  }

  // Active-build stages (only when the latest quarter is itself accumulating).
  if (streak >= config.durable_min_streak) {
    const start = Math.max(0, n - streak);
    const slope = rSquared(acc, start, n - 1);
    if (slope >= config.durable_min_r2) return info("DURABLE");
  }
  if (streak >= 2 && streak <= 3) return info("FORMING");
  if (streak === 1 && Math.abs(latest) >= config.spike_floor_bps) return info("SPIKE");
  return info(null);
}

/**
 * Full historical stage series: loops classifyLifecycleAt over growing prefixes
 * (the SINGLE implementation). `breadthP75` is the per-quarter CROWDED flag
 * (breadth ≥ cross-sectional p75); pass all-false if unknown.
 */
export function classifyLifecycleSeries(
  perQuarterNetBps: number[],
  breadthP75: boolean[] = [],
  config: LifecycleConfig = LIFECYCLE_CONFIG,
): StageInfo[] {
  return perQuarterNetBps.map((_, i) =>
    classifyLifecycleAt(perQuarterNetBps.slice(0, i + 1), breadthP75[i] ?? false, config),
  );
}

export type LifecycleTransition =
  | "→SPIKE"
  | "→FORMING"
  | "→DURABLE"
  | "→CORE"
  | "→CROWDED"
  | "BROKEN";

export interface TransitionEvent {
  index: number; // quarter index the change lands on
  from: LifecycleStage | null;
  to: LifecycleStage | null;
  transition: LifecycleTransition;
  significance: number; // 0-1; BROKEN / →CORE / →CROWDED are the high-significance set
}

/**
 * Emit a transition event on each stage change (and on the first quarter breadth
 * crosses into CROWDED). BROKEN, DURABLE→CROWDED, and →CORE are high-significance.
 */
export function detectTransitions(stages: StageInfo[]): TransitionEvent[] {
  const out: TransitionEvent[] = [];
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]!;
    const cur = stages[i]!;
    if (cur.stage !== prev.stage && cur.stage != null) {
      const transition = (`→${cur.stage}` as LifecycleTransition);
      const high = cur.stage === "BROKEN" || cur.stage === "CORE";
      out.push({ index: i, from: prev.stage, to: cur.stage, transition: cur.stage === "BROKEN" ? "BROKEN" : transition, significance: high ? 1 : 0.5 });
    }
    // CROWDED escalation: first quarter the flag turns on.
    if (cur.crowded && !prev.crowded) {
      out.push({ index: i, from: cur.stage, to: cur.stage, transition: "→CROWDED", significance: 1 });
    }
  }
  return out;
}
