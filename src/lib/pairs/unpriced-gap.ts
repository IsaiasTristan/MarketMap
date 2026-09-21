/**
 * Pairs tab — the unpriced gap, the headline discovery metric (brief §5.5).
 * No I/O.
 *
 *   unpricedGap = z_own(Δ signalGap over 4w) − z_own(relReturn1m)
 *
 * Both quantities are standardised on the PAIR'S OWN history, then subtracted.
 * Large positive = signals diverged, price has not followed yet. Calibration
 * REQUIRES history: below `minWeeks` of the pair's own observations we return
 * `calibrated: false` and expose the raw pp / % instead — we NEVER fabricate a
 * z-score from a short window (§5.5).
 */
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

/** z of the last finite value vs the full finite series (sample sd). */
function zOfLast(series: Array<number | null>): { z: number | null; obs: number; last: number | null } {
  const finite = series.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length < 2) return { z: null, obs: finite.length, last: finite[finite.length - 1] ?? null };
  const last = finite[finite.length - 1]!;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length - 1));
  if (sd < 1e-12) return { z: null, obs: finite.length, last };
  return { z: (last - mean) / sd, obs: finite.length, last };
}

/** Δ over `steps` grid weeks: series[i] - series[i-steps]. */
export function deltaSeries(series: Array<number | null>, steps: number): Array<number | null> {
  const out: Array<number | null> = new Array(series.length).fill(null);
  for (let i = steps; i < series.length; i++) {
    const a = series[i - steps];
    const b = series[i];
    if (a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b)) out[i] = b - a;
  }
  return out;
}

export interface UnpricedGapResult {
  /** z_own(Δgap) − z_own(relReturn1m). Null until calibrated. */
  value: number | null;
  calibrated: boolean;
  /** Count of the pair's own Δgap observations available to standardise on. */
  obsWeeks: number;
  /** Raw latest 4-week change in the signal gap (pp) — shown when uncalibrated. */
  rawDeltaGapPp: number | null;
  /** Raw latest relReturn1m (fraction) — shown when uncalibrated. */
  rawRel1mPct: number | null;
}

/**
 * Do both engines agree on an unpriced gap? A real predicate, not float
 * equality: each engine has a calibrated z-difference of at least `minZ` and
 * they point the same way. `unpricedGapDriver` (the larger magnitude) is only a
 * display tiebreak; THIS is what "both engines fired" means.
 */
export function unpricedEnginesAgree(
  e1: number | null,
  e2: number | null,
  minZ: number,
): boolean {
  return (
    e1 !== null &&
    e2 !== null &&
    Number.isFinite(e1) &&
    Number.isFinite(e2) &&
    Math.sign(e1) === Math.sign(e2) &&
    Math.abs(e1) >= minZ &&
    Math.abs(e2) >= minZ
  );
}

export interface StepPoint {
  /** Size (pp) of the most recent change in the series, carried forward. */
  stepPp: number | null;
  /** Grid weeks since that step landed (0 = this week), null when expired. */
  ageWeeks: number | null;
}

/**
 * The step size of a piecewise-constant series (Engine 2's gap, which only
 * moves on a quarterly refresh). At each index we report the most recent
 * non-zero step and how long ago it happened, carried forward until the next
 * step and expiring after `maxCarryWeeks` so a stale step cannot fire forever.
 */
export function stepSeries(series: Array<number | null>, maxCarryWeeks: number): StepPoint[] {
  const out: StepPoint[] = series.map(() => ({ stepPp: null, ageWeeks: null }));
  let lastStep: number | null = null;
  let lastStepIdx = -1;
  let prev: number | null = null;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v !== null && Number.isFinite(v)) {
      if (prev !== null && Number.isFinite(prev) && Math.abs(v - prev) > 1e-9) {
        lastStep = v - prev;
        lastStepIdx = i;
      }
      prev = v;
    }
    if (lastStepIdx >= 0) {
      const age = i - lastStepIdx;
      out[i] = age <= maxCarryWeeks ? { stepPp: lastStep, ageWeeks: age } : { stepPp: null, ageWeeks: null };
    }
  }
  return out;
}

/**
 * Weeks where an E1 firing and an E2 firing for the SAME pair fall within
 * `window` grid steps of each other. A week is triangulated when one engine
 * fired that week and the other fired within +-window — the explicit,
 * testable version of an implicit intersection.
 */
export function triangulatedWeeks(
  e1Fired: boolean[],
  e2Fired: boolean[],
  window: number,
): boolean[] {
  const n = e1Fired.length;
  const out = new Array<boolean>(n).fill(false);
  const near = (arr: boolean[], i: number): boolean => {
    for (let k = Math.max(0, i - window); k <= Math.min(n - 1, i + window); k++) if (arr[k]) return true;
    return false;
  };
  for (let i = 0; i < n; i++) {
    if ((e1Fired[i] && near(e2Fired, i)) || (e2Fired[i] && near(e1Fired, i))) out[i] = true;
  }
  return out;
}

/**
 * Compute the unpriced gap for ONE engine's gap series against the price series.
 * The service calls this for E1 and E2 separately and records which engine
 * drove the larger positive value (`unpricedGapDriver`).
 */
export function computeUnpricedGap(
  gapSeries: Array<number | null>,
  relReturn1mSeries: Array<number | null>,
  opts: { changeSteps?: number; minWeeks?: number } = {},
): UnpricedGapResult {
  const changeSteps = opts.changeSteps ?? PAIR_THRESHOLDS.gapChangeSteps;
  const minWeeks = opts.minWeeks ?? PAIR_THRESHOLDS.calibrationMinWeeks;
  const dGap = deltaSeries(gapSeries, changeSteps);
  const zGap = zOfLast(dGap);
  const zRel = zOfLast(relReturn1mSeries);
  const obsWeeks = zGap.obs;
  // Calibration hinges on the pair having enough of its OWN history to
  // standardise the signal term. A degenerate (zero-variance) price series
  // means price genuinely has not moved, so its z contributes 0 rather than
  // voiding the metric.
  const calibrated = obsWeeks >= minWeeks && zGap.z !== null;
  return {
    value: calibrated ? zGap.z! - (zRel.z ?? 0) : null,
    calibrated,
    obsWeeks,
    rawDeltaGapPp: zGap.last,
    rawRel1mPct: zRel.last,
  };
}
