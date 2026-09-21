/**
 * Pairs tab — pooled event-study math (brief §10). No I/O.
 *
 * The premise of the whole tab is testable: when the signal gap has moved but
 * the price ratio has not (the stored UNPRICED flag), does the price ratio
 * subsequently move? This module pools every stored pair-week into events
 * (UNPRICED fired) vs a control (all other weeks of the SAME pairs), measures
 * forward relative return at a set of horizons, and reports the evidence with
 * an HONESTLY small effective sample.
 *
 * THE STATISTIC IS THE EXCESS, TESTED DIRECTLY (2026-09-20 rewrite). Every
 * displayed number is event minus control, so the t-statistic must test the
 * SAME quantity. Each event's outcome is two-way demeaned against a baseline
 * fitted on control weeks only:
 *
 *   resid_i = r_i − pairControlMean(pair_i) − weekControlMean(week_i) + grandControlMean
 *
 * removing pair-level drift and market-level (same-week) effects at once. The
 * excess is the mean residual; the t is Newey-West at lag = horizon−1 on the
 * per-week means of those residuals — so "band clears zero" and the t agree by
 * construction. A missing pair or week control DROPS the event and is counted;
 * we never zero-fill. See docs/pairs/validation-precommit.md.
 *
 * The two anti-fooling measures live here, not in the UI:
 *   1. Clustering by week — events in the same week (many pairs) and across
 *      overlapping forward windows are NOT independent, so we collapse to
 *      weekly means and run Newey-West at lag = horizon-1, whose effectiveN is
 *      the real independent-observation count the headline gates on. At long
 *      horizons a non-overlapping cross-check (every h-th week, plain t) is
 *      reported alongside and flagged when it disagrees in sign.
 *   2. A three-part gate — effective weeks AND distinct pairs AND calendar span
 *      must all clear. Span is separate precisely so a large sample packed into
 *      one regime cannot buy a headline.
 */
import { neweyWestTStat } from "@/lib/revision/backtest";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { buildValidationControls, type ControlsResult } from "@/lib/pairs/validation-controls";
export type { ControlsResult, ControlRow, ConcentrationResult } from "@/lib/pairs/validation-controls";

/** Forward horizons in grid weeks. 4 is the headline. */
export const VALIDATION_HORIZONS = [1, 2, 4, 8, 13, 17, 21, 26] as const;
export const PRIMARY_HORIZON = 4;
export const SECONDARY_HORIZON = 13;
/** The three horizons the global toggle exposes and every panel recomputes at. */
export const PANEL_HORIZONS = [4, 13, 26] as const;

export interface PairWeekObservation {
  /** Stable pair identity across weeks: tier|longKey|shortKey|weighting. */
  pairKey: string;
  tier: string; // "T1" | "T2"
  weekIso: string; // YYYY-MM-DD
  /** The event: the stored UNPRICED flag was present this week. */
  fired: boolean;
  /** Every event kind that fired this week (UNPRICED / CONTRARY / E2_UNPRICED /
   *  TRIANGULATED). UNPRICED stays the sole gated headline; the rest are
   *  secondary and each partitions on membership here — never on the driver. */
  firedKinds: string[];
  /** T2 kill-screen provenance; irrelevant (true) for T1. */
  killScreensApplied: boolean;
  /** Event signal for the IC — the unpriced gap (may be null / uncalibrated). */
  signal: number | null;
  /** Forward relative return (log long/short) keyed by horizon; null if unknown. */
  forward: Partial<Record<number, number | null>>;
  // Slice covariates (all optional; a null drops the row from that slice only).
  hedgeEff: number | null;
  residualSharePct: number | null;
  crossSector: boolean;
  crowdingLong: number | null;
  /** Breadth of crowding on the long leg (percent of names above the universe
   *  p90) — the concentration measure, sliced continuously. */
  crowdBreadthLong: number | null;
  valRatioPctile: number | null;
  driver: string | null; // E1 | E2 — magnitude tiebreak only
  /** Smaller leg's name count — the basket-size slice covariate (breadth CI
   *  widens as n falls). Null when neither count is known. */
  minLegNames: number | null;
  /** The E1 gap sat below the name-equivalent noise floor this week. */
  thinGap: boolean;
  /** The sign-flip placebo trigger: the gap NARROWED > threshold while price
   *  stayed flat. Computed in the service (needs e1Gap4wChange + relReturn1m). */
  signFlipFired: boolean;
}

export interface GroupStat {
  events: number;
  distinctPairs: number;
  distinctWeeks: number;
  effectiveSample: number | null;
  /** Raw event mean forward return at the horizon — CONTEXT only. */
  mean: number | null;
  /** Grand control mean forward return — CONTEXT only. */
  controlMean: number | null;
  /** The two-way-demeaned excess (mean residual) — THE number the page shows. */
  excess: number | null;
  median: number | null;
  hitRate: number | null;
  /** Newey-West t on per-week residual means at lag = horizon − 1. */
  tStat: number | null;
  /** Non-overlapping cross-check t (every h-th week, plain t); null below h=8. */
  nonOverlapTStat: number | null;
  nonOverlapWeeks: number | null;
  /** Standard error of the control mean, for a like-for-like comparison. */
  controlStderr: number | null;
  ic: number | null;
  /** Events with a calibrated signal AND a forward return (the IC's real n). */
  icEvents: number;
  /** Events dropped because their pair or week had no control observation. */
  droppedNoControl: number;
  spanMonths: number;
  sampleStart: string | null;
}

export interface DecayPoint {
  horizon: number;
  /** Two-way-demeaned excess (mean residual) — the plotted line + band centre. */
  excess: number | null;
  stderr: number | null;
  /** Raw event mean / control mean, retained for hover context only. */
  rawMean: number | null;
  controlMean: number | null;
  events: number;
}

export interface SliceRow extends GroupStat {
  dimension: string;
  label: string;
  meanSecondary: number | null; // excess at SECONDARY_HORIZON
  /** Excess (two-way-demeaned) at each horizon — powers the per-slice decay
   *  sparkline. */
  decay: { horizon: number; excess: number | null }[];
  /** Full stat at each panel horizon so the global toggle recomputes median /
   *  hit / t / IC, not just excess. */
  byHorizon: Record<number, GroupStat>;
  note: string;
  dimmed: boolean; // below the event or |t| floor
  suppressed: boolean; // below the hard suppression floor — stats rendered as —
  unclassified: boolean; // the null-covariate catch-all row
}

export interface DistPoint {
  mean: number | null;
  median: number | null;
  meanOverMedian: number | null;
  skew: number | null;
  worstDecile: number | null;
  bestDecile: number | null;
  buckets: { from: number; to: number; count: number; label: string; neg: boolean }[];
}

export interface DistributionStat extends DistPoint {
  horizon: number;
  byHorizon: Record<number, DistPoint>;
}

export interface EngineRow {
  engine: string; // "E1" | "E2" | "UNATTRIB" | "BOTH" | "LEG_A" | "E3"
  label: string;
  stat: GroupStat | null;
  byHorizon: Record<number, GroupStat> | null;
  insufficient: boolean;
  note: string;
}

export interface YearRow {
  year: number;
  events: number;
  excess: number | null;
  median: number | null;
  tStat: number | null;
  byHorizon: Record<number, GroupStat>;
}

export interface KindGate {
  ready: boolean;
  effectiveWeeks: number | null;
  distinctPairs: number;
  spanMonths: number;
  targets: { effectiveWeeks: number; distinctPairs: number; spanMonths: number };
  accruing: string[];
}

/** A secondary event kind (CONTRARY / E2_UNPRICED / TRIANGULATED). Each is
 *  individually gated on the SAME three-part effective-sample gate as the
 *  headline and reports an EXCLUSIVE population (this kind only, no UNPRICED)
 *  alongside its MARGINAL one, so Validation rows never double-count. */
export interface SecondaryKindResult {
  kind: string;
  label: string;
  /** TRUE for E2-derived kinds whose evidence is restated-basis and must never
   *  be pooled with Leg B. */
  restatedBasis: boolean;
  /** Every week this kind fired (may overlap UNPRICED). */
  marginal: GroupStat;
  marginalByHorizon: Record<number, GroupStat>;
  /** Weeks this kind fired and UNPRICED did NOT — the non-double-counting cut. */
  exclusive: GroupStat;
  exclusiveByHorizon: Record<number, GroupStat>;
  gate: KindGate;
  note: string;
}

export interface CoverageRow {
  input: string;
  from: string | null;
  depth: string;
  why: string;
}

export interface SplitStat {
  events: number;
  byHorizon: Record<number, GroupStat>;
  /** Events with a complete forward window at each horizon — held-out power
   *  collapses at long horizons because recent events lack the future. */
  eventsByHorizon: Record<number, number>;
}

export interface ValidationResult {
  primaryHorizon: number;
  secondaryHorizon: number;
  horizons: number[];
  panelHorizons: number[];
  eventRule: string;
  totals: { pairWeeks: number; events: number; controlWeeks: number; distinctPairs: number; distinctWeeks: number };
  span: { start: string | null; end: string | null; months: number };
  heldOutFrom: string;
  forwardReserveFrom: string;
  /** UNPRICED fired on this share of pair-weeks, and this share of pairs fired
   *  at least once — states plainly that the flag is ~a top-decile cut (§D5). */
  fireRatePct: number;
  pairsFiringPct: number;
  headline: {
    ready: boolean;
    effectiveWeeks: number | null;
    distinctPairs: number;
    spanMonths: number;
    targets: { effectiveWeeks: number; distinctPairs: number; spanMonths: number };
    accruing: string[]; // which inputs are still short of target
    stat: GroupStat | null; // only meaningful when ready
    /** The primary-horizon stat ALWAYS, for the claim panel's number list —
     *  present even while accruing (a diagnostic, not a leaderboard claim). */
    diagnosticStat: GroupStat;
    /** Full stat at each panel horizon so the claim panel follows the toggle. */
    byHorizon: Record<number, GroupStat>;
  };
  splits: {
    inSample: SplitStat;
    observedOutOfSample: SplitStat;
  };
  decay: DecayPoint[];
  engines: EngineRow[];
  /** Additive secondary event kinds — each individually gated, never pooled
   *  into the UNPRICED headline. */
  secondaryKinds: SecondaryKindResult[];
  slices: SliceRow[];
  distribution: DistributionStat;
  yearByYear: YearRow[];
  coverage: CoverageRow[];
  controls: ControlsResult;
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------
function finite(xs: Array<number | null | undefined>): number[] {
  return xs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function monthsBetween(a: string, b: string): number {
  const d1 = new Date(`${a}T00:00:00Z`).getTime();
  const d2 = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(d2 - d1) / (1000 * 60 * 60 * 24 * 30.4375);
}
/** Plain (non-HAC) t of a sample against zero. */
function plainT(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  if (!(sd > 1e-18)) return null;
  return m / (sd / Math.sqrt(xs.length));
}
/** Spearman rank correlation, dropping non-finite pairs. */
function spearman(pairs: Array<[number, number]>): number | null {
  const xs = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (xs.length < 3) return null;
  const rank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(vals.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs.map((p) => p[0]));
  const ry = rank(xs.map((p) => p[1]));
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}
function skewness(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  if (!(sd > 1e-12)) return null;
  return xs.reduce((a, b) => a + ((b - m) / sd) ** 3, 0) / n;
}
function decile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.max(0, Math.min(s.length - 1, Math.floor(q * (s.length - 1))));
  return s[i]!;
}
/** Per-week means of raw forward returns at a horizon. */
function weeklyRawMeans(obs: PairWeekObservation[], horizon: number): number[] {
  const byWeek = new Map<string, number[]>();
  for (const e of obs) {
    const v = e.forward[horizon];
    if (typeof v === "number" && Number.isFinite(v)) (byWeek.get(e.weekIso) ?? byWeek.set(e.weekIso, []).get(e.weekIso)!).push(v);
  }
  return [...byWeek.keys()].sort().map((w) => mean(byWeek.get(w)!)!);
}

interface Residual {
  weekIso: string;
  pairKey: string;
  value: number;
}

/**
 * Two-way demeaning. Fit pair and week baselines on CONTROL weeks only, then
 * apply to events: resid = r − pairCtrl − weekCtrl + grandCtrl. Drop-and-count
 * an event whose pair or week has no control observation; never zero-fill.
 */
export function excessResiduals(
  events: PairWeekObservation[],
  control: PairWeekObservation[],
  horizon: number,
): { residuals: Residual[]; droppedNoControl: number; grandControlMean: number | null } {
  const ctrlVals: number[] = [];
  const pairSum = new Map<string, { s: number; n: number }>();
  const weekSum = new Map<string, { s: number; n: number }>();
  for (const c of control) {
    const v = c.forward[horizon];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    ctrlVals.push(v);
    const p = pairSum.get(c.pairKey) ?? { s: 0, n: 0 };
    p.s += v;
    p.n += 1;
    pairSum.set(c.pairKey, p);
    const w = weekSum.get(c.weekIso) ?? { s: 0, n: 0 };
    w.s += v;
    w.n += 1;
    weekSum.set(c.weekIso, w);
  }
  const grand = ctrlVals.length ? ctrlVals.reduce((a, b) => a + b, 0) / ctrlVals.length : null;
  const residuals: Residual[] = [];
  let dropped = 0;
  if (grand === null) {
    // No control observations at all — cannot demean; drop everything.
    return { residuals, droppedNoControl: finite(events.map((e) => e.forward[horizon])).length, grandControlMean: null };
  }
  for (const e of events) {
    const r = e.forward[horizon];
    if (typeof r !== "number" || !Number.isFinite(r)) continue;
    const p = pairSum.get(e.pairKey);
    const w = weekSum.get(e.weekIso);
    if (!p || !w) {
      dropped += 1;
      continue;
    }
    residuals.push({ weekIso: e.weekIso, pairKey: e.pairKey, value: r - p.s / p.n - w.s / w.n + grand });
  }
  return { residuals, droppedNoControl: dropped, grandControlMean: grand };
}

function weeklyResidualMeans(residuals: Residual[]): { weeks: string[]; means: number[] } {
  const byWeek = new Map<string, number[]>();
  for (const r of residuals) (byWeek.get(r.weekIso) ?? byWeek.set(r.weekIso, []).get(r.weekIso)!).push(r.value);
  const weeks = [...byWeek.keys()].sort();
  return { weeks, means: weeks.map((w) => mean(byWeek.get(w)!)!) };
}

export function groupStat(
  events: PairWeekObservation[],
  control: PairWeekObservation[],
  horizon: number,
): GroupStat {
  const evVals = finite(events.map((e) => e.forward[horizon]));
  const { residuals, droppedNoControl, grandControlMean } = excessResiduals(events, control, horizon);
  const { weeks, means } = weeklyResidualMeans(residuals);
  const nw = neweyWestTStat(means, horizon - 1);
  const excess = residuals.length ? mean(residuals.map((r) => r.value)) : null;

  // Non-overlapping cross-check at long horizons.
  let nonOverlapTStat: number | null = null;
  let nonOverlapWeeks: number | null = null;
  if (horizon >= 8 && means.length >= 2) {
    const step = Math.max(1, horizon);
    const sampled: number[] = [];
    for (let i = 0; i < means.length; i += step) sampled.push(means[i]!);
    nonOverlapTStat = plainT(sampled);
    nonOverlapWeeks = sampled.length;
  }

  // Control standard error, from the control's own per-week means.
  const ctrlWeekly = weeklyRawMeans(control, horizon);
  const controlStderr =
    ctrlWeekly.length >= 2
      ? Math.sqrt(ctrlWeekly.reduce((a, b) => a + (b - mean(ctrlWeekly)!) ** 2, 0) / (ctrlWeekly.length - 1)) / Math.sqrt(ctrlWeekly.length)
      : null;

  const weeksIso = events.map((e) => e.weekIso).sort();
  const start = weeksIso[0] ?? null;
  const end = weeksIso[weeksIso.length - 1] ?? null;
  const icPairs = events
    .filter((e) => typeof e.signal === "number" && typeof e.forward[horizon] === "number")
    .map((e) => [e.signal as number, e.forward[horizon] as number] as [number, number]);
  const ic = spearman(icPairs);
  // Hit rate is now beating the two-way-demeaned baseline (residual > 0).
  const hitRate = residuals.length ? residuals.filter((r) => r.value > 0).length / residuals.length : null;

  return {
    events: evVals.length,
    distinctPairs: new Set(events.map((e) => e.pairKey)).size,
    distinctWeeks: weeks.length,
    effectiveSample: nw.effectiveN === null ? null : Math.round(nw.effectiveN * 10) / 10,
    mean: mean(evVals),
    controlMean: grandControlMean,
    excess,
    median: median(evVals),
    hitRate,
    tStat: nw.tStat,
    nonOverlapTStat,
    nonOverlapWeeks,
    controlStderr,
    ic,
    icEvents: icPairs.length,
    droppedNoControl,
    spanMonths: start && end ? Math.round(monthsBetween(start, end) * 10) / 10 : 0,
    sampleStart: start,
  };
}

function statByHorizon(
  events: PairWeekObservation[],
  control: PairWeekObservation[],
  horizons: readonly number[],
): Record<number, GroupStat> {
  const out: Record<number, GroupStat> = {};
  for (const h of horizons) out[h] = groupStat(events, control, h);
  return out;
}

function buildSlice(
  dimension: string,
  label: string,
  events: PairWeekObservation[],
  control: PairWeekObservation[],
  note: string,
  t = PAIR_THRESHOLDS,
  unclassified = false,
): SliceRow {
  const byHorizon = statByHorizon(events, control, PANEL_HORIZONS);
  const s = byHorizon[PRIMARY_HORIZON]!;
  const secondary = byHorizon[SECONDARY_HORIZON] ?? groupStat(events, control, SECONDARY_HORIZON);
  const dimmed = s.events < t.validationSliceMinEvents || s.tStat === null || Math.abs(s.tStat) < t.validationSliceMinT;
  const suppressed = s.events < t.validationSuppressBelowEvents || s.distinctWeeks < t.validationSuppressBelowWeeks;
  const decay = VALIDATION_HORIZONS.map((h) => {
    const { residuals } = excessResiduals(events, control, h);
    return { horizon: h, excess: residuals.length ? mean(residuals.map((r) => r.value)) : null };
  });
  return { ...s, dimension, label, meanSecondary: secondary.excess, decay, byHorizon, note, dimmed, suppressed, unclassified };
}

/** Bucketed grouping with an explicit unclassified (null-covariate) catch-all. */
function pushBuckets(
  slices: SliceRow[],
  dimension: string,
  edges: number[],
  labels: string[],
  accessor: (o: PairWeekObservation) => number | null,
  note: string,
  nullLabel: string,
  events: PairWeekObservation[],
  control: PairWeekObservation[],
  t: typeof PAIR_THRESHOLDS,
): void {
  const bucketOf = (v: number | null): number => {
    if (v === null || !Number.isFinite(v)) return -1;
    for (let i = 0; i < edges.length; i++) if (v < edges[i]!) return i;
    return edges.length;
  };
  for (let b = 0; b <= edges.length; b++) {
    const inB = (o: PairWeekObservation) => bucketOf(accessor(o)) === b;
    slices.push(buildSlice(dimension, labels[b]!, events.filter(inB), control.filter(inB), note, t));
  }
  const isNull = (o: PairWeekObservation) => bucketOf(accessor(o)) === -1;
  const unEv = events.filter(isNull);
  if (unEv.length > 0) {
    slices.push(buildSlice(dimension, `unclassified (${nullLabel})`, unEv, control.filter(isNull), "covariate not available this week", t, true));
  }
}

function distAt(events: PairWeekObservation[], horizon: number): DistPoint {
  const vals = finite(events.map((e) => e.forward[horizon]));
  const distMean = mean(vals);
  const distMedian = median(vals);
  const SENT = 10; // finite sentinel so JSON round-trips (no Infinity -> null).
  const edges = [-0.15, -0.08, -0.03, 0, 0.03, 0.08, 0.15];
  const bins = [-SENT, ...edges, SENT];
  const buckets: DistPoint["buckets"] = [];
  for (let i = 0; i < bins.length - 1; i++) {
    const from = bins[i]!;
    const to = bins[i + 1]!;
    const count = vals.filter((v) => v >= from && v < to).length;
    const label = i === 0 ? "< -15" : i === bins.length - 2 ? "> +15" : `${Math.round(to * 100)}`;
    buckets.push({ from, to, count, label, neg: to <= 0 });
  }
  return {
    mean: distMean,
    median: distMedian,
    meanOverMedian: distMean !== null && distMedian !== null && Math.abs(distMedian) > 1e-9 ? distMean / distMedian : null,
    skew: skewness(vals),
    worstDecile: decile(vals, 0.1),
    bestDecile: decile(vals, 0.9),
    buckets,
  };
}

/**
 * The whole pooled event study. Pure: everything depends only on the
 * observations and the (optionally overridden) thresholds.
 */
export function poolEventStudy(
  observations: PairWeekObservation[],
  opts: { heldOutFrom?: string; forwardReserveFrom?: string; t?: typeof PAIR_THRESHOLDS } = {},
): ValidationResult {
  const t = opts.t ?? PAIR_THRESHOLDS;
  const heldOutFrom = opts.heldOutFrom ?? "";
  const forwardReserveFrom = opts.forwardReserveFrom ?? "";
  const events = observations.filter((o) => o.fired);
  const control = observations.filter((o) => !o.fired);
  const allWeeks = observations.map((o) => o.weekIso).sort();
  const start = allWeeks[0] ?? null;
  const end = allWeeks[allWeeks.length - 1] ?? null;
  const spanMonths = start && end ? Math.round(monthsBetween(start, end) * 10) / 10 : 0;

  const eventRule = `UNPRICED: 4-week signal-gap change > ${t.unpricedGapPp}pp while |relative 1m return| <= ${(t.unpricedRelBand * 100).toFixed(0)}%`;

  // Headline at the primary horizon, plus every panel horizon.
  const headlineByHorizon = statByHorizon(events, control, PANEL_HORIZONS);
  const headlineStat = headlineByHorizon[PRIMARY_HORIZON]!;
  const effectiveWeeks = headlineStat.effectiveSample;
  const distinctPairs = headlineStat.distinctPairs;
  const ready =
    effectiveWeeks !== null &&
    effectiveWeeks >= t.validationHeadlineMinWeeks &&
    distinctPairs >= t.validationHeadlineMinPairs &&
    spanMonths >= t.validationHeadlineMinSpanMonths;
  const accruing: string[] = [];
  if (effectiveWeeks === null || effectiveWeeks < t.validationHeadlineMinWeeks) accruing.push("effective weeks");
  if (distinctPairs < t.validationHeadlineMinPairs) accruing.push("distinct pairs");
  if (spanMonths < t.validationHeadlineMinSpanMonths) accruing.push("calendar span");

  // In-sample vs observed-out-of-sample split (§D2). Each partition demeans
  // against its own control weeks so the comparison is like-for-like.
  const splitStat = (from: string | null, to: string | null): SplitStat => {
    const inRange = (o: PairWeekObservation) => (from === null || o.weekIso >= from) && (to === null || o.weekIso < to);
    const ev = events.filter(inRange);
    const ct = control.filter(inRange);
    const byHorizon = statByHorizon(ev, ct, PANEL_HORIZONS);
    const eventsByHorizon: Record<number, number> = {};
    for (const h of PANEL_HORIZONS) eventsByHorizon[h] = finite(ev.map((e) => e.forward[h])).length;
    return { events: ev.length, byHorizon, eventsByHorizon };
  };
  const splits = {
    inSample: splitStat(null, heldOutFrom || null),
    observedOutOfSample: splitStat(heldOutFrom || null, null),
  };

  // Decay curve — the plotted line is the two-way-demeaned excess with its band.
  const decay: DecayPoint[] = VALIDATION_HORIZONS.map((h) => {
    const { residuals } = excessResiduals(events, control, h);
    const { means } = weeklyResidualMeans(residuals);
    const nw = neweyWestTStat(means, h - 1);
    const excess = residuals.length ? mean(residuals.map((r) => r.value)) : null;
    const stderr = nw.tStat !== null && nw.mean !== null && Math.abs(nw.tStat) > 1e-9 ? Math.abs(nw.mean / nw.tStat) : null;
    return {
      horizon: h,
      excess,
      stderr,
      rawMean: mean(finite(events.map((e) => e.forward[h]))),
      controlMean: mean(finite(control.map((e) => e.forward[h]))),
      events: finite(events.map((e) => e.forward[h])).length,
    };
  });

  // Per-kind populations — an event of a given KIND is any week that kind's
  // flag fired; its control is every week that kind did NOT fire (like-for-like
  // two-way demeaning). Partitioning is on firedKinds, never the display driver.
  const kindEvents = (kind: string) => observations.filter((o) => o.firedKinds.includes(kind));
  const kindControl = (kind: string) => observations.filter((o) => !o.firedKinds.includes(kind));
  const kindGate = (stat: GroupStat): KindGate => {
    const ew = stat.effectiveSample;
    const dp = stat.distinctPairs;
    const sm = stat.spanMonths;
    const acc: string[] = [];
    if (ew === null || ew < t.validationHeadlineMinWeeks) acc.push("effective weeks");
    if (dp < t.validationHeadlineMinPairs) acc.push("distinct pairs");
    if (sm < t.validationHeadlineMinSpanMonths) acc.push("calendar span");
    return {
      ready: acc.length === 0,
      effectiveWeeks: ew,
      distinctPairs: dp,
      spanMonths: sm,
      targets: {
        effectiveWeeks: t.validationHeadlineMinWeeks,
        distinctPairs: t.validationHeadlineMinPairs,
        spanMonths: t.validationHeadlineMinSpanMonths,
      },
      accruing: acc,
    };
  };

  // Per-engine breakdown, partitioned on the firing kind (§1b): E1 = UNPRICED
  // (Leg-B analyst-revision gap, the sole gated headline), E2 = E2_UNPRICED
  // (restated-basis inflection step), BOTH = TRIANGULATED (both fired in-window).
  const engineRow = (engine: string, label: string, kind: string, staticNote = ""): EngineRow => {
    const evs = kindEvents(kind);
    const ctl = kindControl(kind);
    const byHorizon = statByHorizon(evs, ctl, PANEL_HORIZONS);
    const stat = byHorizon[PRIMARY_HORIZON]!;
    const insufficient = stat.events === 0;
    return { engine, label, stat, byHorizon, insufficient, note: insufficient ? staticNote || "no events on this kind yet" : "" };
  };
  const engines: EngineRow[] = [
    engineRow("E1", "Leg B — analyst revisions (UNPRICED)", "UNPRICED"),
    engineRow("E2", "Engine 2 — inflection step (E2_UNPRICED, restated-basis)", "E2_UNPRICED"),
    engineRow("BOTH", "Both engines fired in-window (TRIANGULATED)", "TRIANGULATED"),
    { engine: "LEG_A", label: "Leg A — estimate revisions", stat: null, byHorizon: null, insufficient: true, note: "insufficient history — not yet an event driver" },
    { engine: "E3", label: "Engine 3 — 13F flows", stat: null, byHorizon: null, insufficient: true, note: "confirming signal only — never fires an event" },
  ];

  // Secondary event kinds (§2). Each is individually gated on the same
  // three-part gate and reports its MARGINAL population (every week it fired)
  // and its EXCLUSIVE population (fired while UNPRICED did NOT) so Validation
  // rows never double-count the headline.
  const secondaryKind = (
    kind: string,
    label: string,
    restatedBasis: boolean,
    note: string,
  ): SecondaryKindResult => {
    const marg = kindEvents(kind);
    const margCtl = kindControl(kind);
    const marginalByHorizon = statByHorizon(marg, margCtl, PANEL_HORIZONS);
    const excl = marg.filter((o) => !o.firedKinds.includes("UNPRICED"));
    const exclCtl = observations.filter((o) => !(o.firedKinds.includes(kind) && !o.firedKinds.includes("UNPRICED")));
    const exclusiveByHorizon = statByHorizon(excl, exclCtl, PANEL_HORIZONS);
    return {
      kind,
      label,
      restatedBasis,
      marginal: marginalByHorizon[PRIMARY_HORIZON]!,
      marginalByHorizon,
      exclusive: exclusiveByHorizon[PRIMARY_HORIZON]!,
      exclusiveByHorizon,
      gate: kindGate(marginalByHorizon[PRIMARY_HORIZON]!),
      note,
    };
  };
  const secondaryKinds: SecondaryKindResult[] = [
    secondaryKind(
      "CONTRARY",
      "Contrary — gap widened while price moved the WRONG way",
      false,
      "disjoint from UNPRICED by construction (price fell past the band, not within it).",
    ),
    secondaryKind(
      "E2_UNPRICED",
      "Engine-2 unpriced — inflection step, price flat",
      true,
      "restated-basis (reconstructed statement history); never pooled with Leg B evidence.",
    ),
    secondaryKind(
      "TRIANGULATED",
      "Triangulated — Leg B and Engine 2 both fired in-window",
      true,
      "carries an Engine-2 leg, so treated as restated-basis; the strongest agreement cut.",
    ),
  ];

  // Slices — every cut computes; the UI dims / suppresses rows below the floors.
  const slices: SliceRow[] = [];
  // by tier (T2 screened vs unscreened kept separate, never pooled).
  const t1 = observations.filter((o) => o.tier === "T1");
  const t2s = observations.filter((o) => o.tier === "T2" && o.killScreensApplied);
  const t2u = observations.filter((o) => o.tier === "T2" && !o.killScreensApplied);
  slices.push(buildSlice("tier", "Tier 1 (baskets)", t1.filter((o) => o.fired), t1.filter((o) => !o.fired), "breadth pairs — no per-name quality flags", t));
  slices.push(buildSlice("tier", "Tier 2 — screened", t2s.filter((o) => o.fired), t2s.filter((o) => !o.fired), "kill screens applied (fundamental job era)", t));
  slices.push(buildSlice("tier", "Tier 2 — unscreened", t2u.filter((o) => o.fired), t2u.filter((o) => !o.fired), "pre-cutoff, no quality flags — distinct population", t));
  // by hedge efficiency bucket.
  pushBuckets(
    slices, "hedgeEff", [0.3, 0.5, 0.7], ["< 0.3 (not a pair)", "0.3–0.5", "0.5–0.7", ">= 0.7"],
    (o) => o.hedgeEff, "hedge-efficiency bucket", "no hedge efficiency", events, control, t,
  );
  // by residual share bucket.
  pushBuckets(
    slices, "residualShare", [40, 60], ["< 40% (factor bet)", "40–60%", ">= 60% (stock-specific)"],
    (o) => o.residualSharePct, "stock-specific share of spread risk", "no residual share", events, control, t,
  );
  // within vs cross sector.
  slices.push(buildSlice("scope", "Within-sector", events.filter((o) => !o.crossSector), control.filter((o) => !o.crossSector), "both legs in one sector", t));
  slices.push(buildSlice("scope", "Cross-sector", events.filter((o) => o.crossSector), control.filter((o) => o.crossSector), "legs span sectors", t));
  // by crowding-long bucket. Recalibrated to the observed basket-average
  // distribution (§D4): crowdingLong is a basket average of per-name "% of
  // tracked funds", which tops out near ~29% and averages ~1.7% — the old
  // 40/60 name-level edges could never fire.
  pushBuckets(
    slices, "crowding", [2, 8], ["< 2% (thin)", "2–8%", ">= 8% (relatively crowded)"],
    (o) => o.crowdingLong, "watchlist-fund crowding on the long leg (basket average)", "no crowding data", events, control, t,
  );
  // by crowding BREADTH on the long leg — the concentration measure (percent of
  // the basket's names above the universe p90), not the basket mean (§3).
  pushBuckets(
    slices, "crowdBreadth", [10, 30], ["< 10% of names crowded", "10–30%", ">= 30% (broadly crowded)"],
    (o) => o.crowdBreadthLong, "share of the long leg's names above the universe crowding p90", "no crowding breadth", events, control, t,
  );
  // by valuation percentile bucket.
  pushBuckets(
    slices, "valuation", [33, 66], ["cheap (< 33rd)", "mid (33–66th)", "rich (>= 66th)"],
    (o) => o.valRatioPctile, "long/short valuation-ratio percentile", "no valuation percentile", events, control, t,
  );
  // by basket size (smaller leg).
  pushBuckets(
    slices, "basketSize", [13, 21], ["<= 12 names", "13-20 names", ">= 21 names"],
    (o) => o.minLegNames, "smaller-leg name count — breadth CI widens as n falls", "no name count", events, control, t,
  );
  // thin gap vs not (among fired events, each against its own controls).
  slices.push(buildSlice("thinGap", "below noise floor (thin)", events.filter((o) => o.thinGap), control.filter((o) => o.thinGap), "|gap| under the name-equivalent floor", t));
  slices.push(buildSlice("thinGap", "above noise floor", events.filter((o) => !o.thinGap), control.filter((o) => !o.thinGap), "|gap| clears the name-equivalent floor", t));
  // held-out period.
  if (heldOutFrom) {
    const inHeld = (o: PairWeekObservation) => o.weekIso >= heldOutFrom;
    slices.push(buildSlice("heldOut", `observed OOS (>= ${heldOutFrom})`, events.filter(inHeld), control.filter(inHeld), "observed out-of-sample — see the two-headline split", t));
  }

  // Outcome distribution at the primary horizon, plus every panel horizon.
  const distByHorizon: Record<number, DistPoint> = {};
  for (const h of PANEL_HORIZONS) distByHorizon[h] = distAt(events, h);
  const distribution: DistributionStat = { horizon: PRIMARY_HORIZON, ...distByHorizon[PRIMARY_HORIZON]!, byHorizon: distByHorizon };

  // Year by year at every panel horizon.
  const byYear = new Map<number, PairWeekObservation[]>();
  for (const e of events) {
    const y = Number(e.weekIso.slice(0, 4));
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(e);
  }
  const yearByYear: YearRow[] = [...byYear.keys()].sort().map((y) => {
    const byHorizon = statByHorizon(byYear.get(y)!, control, PANEL_HORIZONS);
    const s = byHorizon[PRIMARY_HORIZON]!;
    return { year: y, events: s.events, excess: s.excess, median: s.median, tStat: s.tStat, byHorizon };
  });

  // Coverage — data-derived start dates, not a hardcoded constant (§B2).
  const e1Start = engines.find((e) => e.engine === "E1")?.stat?.sampleStart ?? null;
  const e2Start = engines.find((e) => e.engine === "E2")?.stat?.sampleStart ?? null;
  const coverage: CoverageRow[] = [
    { input: "Engine 1 — Leg B ratings / targets", from: e1Start ?? start, depth: "full", why: "point-in-time TipRanks + FMP vendor history, meshed (two vendors, cancel-safe)." },
    { input: "Engine 2 — fundamental inflection", from: e2Start ?? start, depth: "full", why: "reconstructed from restated statement history — restated-basis look-ahead." },
    { input: "Engine 1 — Leg A estimate revisions", from: null, depth: "partial", why: "vendor serves current consensus only — not yet an event driver." },
    { input: "Engine 3 — 13F flows", from: start, depth: "full", why: "~45-day filing lag baked into every observation; confirms, never leads." },
    { input: "Engine 4 — factor model", from: start, depth: "full", why: "betas shrunk toward the subsector mean; short-history names carry more error." },
  ];

  // Fire rate + concentration + placebo / sign-flip / known-answer controls.
  const distinctPairsAll = new Set(observations.map((o) => o.pairKey)).size;
  const firingPairs = new Set(events.map((o) => o.pairKey)).size;
  const fireRatePct = observations.length ? (events.length / observations.length) * 100 : 0;
  const pairsFiringPct = distinctPairsAll ? (firingPairs / distinctPairsAll) * 100 : 0;
  const controls = buildValidationControls(observations);

  return {
    primaryHorizon: PRIMARY_HORIZON,
    secondaryHorizon: SECONDARY_HORIZON,
    horizons: [...VALIDATION_HORIZONS],
    panelHorizons: [...PANEL_HORIZONS],
    eventRule,
    totals: {
      pairWeeks: observations.length,
      events: events.length,
      controlWeeks: control.length,
      distinctPairs: distinctPairsAll,
      distinctWeeks: new Set(observations.map((o) => o.weekIso)).size,
    },
    span: { start, end, months: spanMonths },
    heldOutFrom,
    forwardReserveFrom,
    fireRatePct: Math.round(fireRatePct * 10) / 10,
    pairsFiringPct: Math.round(pairsFiringPct * 10) / 10,
    headline: {
      ready,
      effectiveWeeks,
      distinctPairs,
      spanMonths,
      targets: {
        effectiveWeeks: t.validationHeadlineMinWeeks,
        distinctPairs: t.validationHeadlineMinPairs,
        spanMonths: t.validationHeadlineMinSpanMonths,
      },
      accruing,
      stat: ready ? headlineStat : null,
      diagnosticStat: headlineStat,
      byHorizon: headlineByHorizon,
    },
    splits,
    decay,
    engines,
    secondaryKinds,
    slices,
    distribution,
    yearByYear,
    coverage,
    controls,
  };
}
