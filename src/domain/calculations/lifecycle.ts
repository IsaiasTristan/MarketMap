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

// WATCH = a DURABLE/CORE-shaped build carried by fewer than min_participants_stage
// funds (e.g. one fund's steady adds moving the all-funds mean). Not a real durable —
// surfaced as an "n=1 watch" item, never a durable card, and not transition-worthy.
export type LifecycleStage = "SPIKE" | "FORMING" | "DURABLE" | "CORE" | "BROKEN" | "WATCH";

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
  /** Minimum participating funds (holders) for a build to qualify as DURABLE/CORE.
   *  Below this it is WATCH (a single fund's adds are not a durable build). */
  min_participants_stage: number;
}

export const LIFECYCLE_CONFIG: LifecycleConfig = {
  spike_floor_bps: 3,
  durable_min_streak: 4,
  durable_min_r2: 0.7,
  core_deadzone_bps: 0.5,
  core_min_plateau_qtrs: 2,
  core_retained_pct: 0.8,
  broken_min_streak: 3,
  min_participants_stage: 3,
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
  /** Participating funds (holders) at this quarter — DURABLE/CORE require
   *  ≥ min_participants_stage, else the shape downgrades to WATCH. Defaults to
   *  Infinity (no floor) so series without participant data are unaffected. */
  participantsAt = Infinity,
): StageInfo {
  const n = perQuarterNetBps.length;
  const acc = cumulativeAccSeries(perQuarterNetBps);
  // Streak noise floor is tied to the lifecycle plateau deadzone so a "flat"
  // quarter reads the same to the streak and to the CORE plateau test.
  const streakCfg = { ...FLOW_TRAJECTORY_CONFIG, noise_floor_bps: config.core_deadzone_bps };
  const streak = accumulationStreak(perQuarterNetBps, streakCfg);
  const info = (stage: LifecycleStage | null): StageInfo => ({ stage, crowded: breadthAtP75, streak });
  const belowFloor = participantsAt < config.min_participants_stage;
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

  // A trailing plateau (flat quarters) sitting on top of a qualifying DURABLE build.
  // Once the plateau reaches core_min_plateau_qtrs the build graduates to CORE; a
  // SHORTER plateau (a durable build that merely paused a quarter) stays DURABLE
  // rather than flickering to null — so DURABLE → CORE is a contiguous, drawable
  // transition instead of DURABLE → null → CORE.
  let plateauLen = 0;
  for (let i = n - 1; i >= 0 && Math.abs(perQuarterNetBps[i] ?? 0) <= floor; i--) plateauLen++;
  if (plateauLen >= 1) {
    const buildEnd = n - 1 - plateauLen; // last active-build index before the plateau
    if (buildEnd >= 0) {
      const buildStreak = accumulationStreak(perQuarterNetBps.slice(0, buildEnd + 1), streakCfg);
      const buildStart = buildEnd - (Math.abs(buildStreak) - 1);
      const slope = rSquared(acc, Math.max(0, buildStart), buildEnd);
      const peak = Math.max(...acc);
      const retained = peak > 0 ? (acc[n - 1] ?? 0) / peak : 0;
      if (buildStreak >= config.durable_min_streak && slope >= config.durable_min_r2 && retained >= config.core_retained_pct) {
        if (belowFloor) return info("WATCH");
        return info(plateauLen >= config.core_min_plateau_qtrs ? "CORE" : "DURABLE");
      }
    }
  }

  // Active-build stages (only when the latest quarter is itself accumulating).
  if (streak >= config.durable_min_streak) {
    const start = Math.max(0, n - streak);
    const slope = rSquared(acc, start, n - 1);
    if (slope >= config.durable_min_r2) return info(belowFloor ? "WATCH" : "DURABLE");
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
  /** Participating funds (holders) per quarter; default all-Infinity (no floor). */
  participants: number[] = [],
): StageInfo[] {
  return perQuarterNetBps.map((_, i) =>
    classifyLifecycleAt(perQuarterNetBps.slice(0, i + 1), breadthP75[i] ?? false, config, participants[i] ?? Infinity),
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

/** A real, transition-worthy stage: not null and not the soft WATCH pre-stage. */
function isRealStage(s: LifecycleStage | null): s is LifecycleStage {
  return s != null && s !== "WATCH";
}

/**
 * Emit a transition event ONLY on a genuine stage change (Part 3): stage(q) !=
 * stage(q-1) with BOTH non-null and non-WATCH. This excludes:
 *   - same-state "X → X" (no change),
 *   - null-origin "— → X" (a name's genuine first classification is not drawn),
 *   - "— → BROKEN" (BROKEN needs a prior real streak, so its origin is never null),
 *   - CROWDED escalations (CROWDED is a flag, not a stage — it rode here as bogus
 *     "X → X" same-state events; it belongs on the scatter, not the ledger),
 *   - WATCH (a sub-scale pre-stage, treated like null).
 * BROKEN and →CORE are the high-significance set.
 */
export function detectTransitions(stages: StageInfo[]): TransitionEvent[] {
  const out: TransitionEvent[] = [];
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]!.stage;
    const cur = stages[i]!.stage;
    if (!isRealStage(prev) || !isRealStage(cur) || cur === prev) continue;
    const high = cur === "BROKEN" || cur === "CORE";
    out.push({
      index: i,
      from: prev,
      to: cur,
      transition: cur === "BROKEN" ? "BROKEN" : (`→${cur}` as LifecycleTransition),
      significance: high ? 1 : 0.5,
    });
  }
  return out;
}
