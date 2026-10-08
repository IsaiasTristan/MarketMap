/**
 * Engine 1 — revision signal research lab (PURE, no I/O). Given the point-in-time
 * weekly primitives (meshed PT panels, per-analyst TipRanks recommendations,
 * rating net-action series, weekly closes) it builds a family of candidate
 * signal definitions and evaluates each — Spearman IC, Newey-West t, decile
 * spread + monotonicity, per-year stability, signal autocorrelation (turnover
 * proxy), coverage — with an out-of-sample train/test split.
 *
 * Nothing here writes to production tables; the script `revision-signal-lab`
 * loads the DB, calls these builders, and prints a table + JSON for review.
 */
import {
  decileForwardStats,
  neweyWestTStat,
  spearman,
  spearmanIC,
  type SignalReturnPair,
} from "@/lib/revision/backtest";
import { zScores } from "@/lib/revision/scoring";
import type { PtPanel } from "@/lib/revision/legb-history";

type Series = Array<number | null>;
type SeriesByTicker = Map<string, Series>;

/** One analyst's recommendation print (buy/hold/sell mapped to +1/0/-1). */
export interface RecoEventLike {
  dateIso: string;
  key: string; // expertUID
  score: number; // +1 buy, 0 hold, -1 sell
}

export interface LabTickerInput {
  ticker: string;
  panels: PtPanel[]; // meshed PT panel per grid week
  netUpDown: number[]; // weekly net rating-action score (weeklyNetActions)
  recoEvents: RecoEventLike[]; // per-analyst TipRanks recommendations
  closes: Series; // weekly closes
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Per-ticker primitive transforms
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Weekly matched-panel PT revision + matched count + net up/down count. */
function weeklyPtMatched(panels: PtPanel[], cap?: number): {
  rev: Series;
  matched: number[];
  upDown: Series;
} {
  const rev: Series = [];
  const matched: number[] = [];
  const upDown: Series = [];
  for (let i = 0; i < panels.length; i++) {
    if (i === 0) {
      rev.push(null);
      matched.push(0);
      upDown.push(null);
      continue;
    }
    const prev = panels[i - 1]!;
    const cur = panels[i]!;
    let sum = 0;
    let n = 0;
    let ud = 0;
    for (const [k, v] of cur) {
      const p = prev.get(k);
      if (!p || p.pt <= 0) continue;
      let ch = v.pt / p.pt - 1;
      if (cap !== undefined) ch = Math.max(-cap, Math.min(cap, ch));
      sum += ch;
      if (v.pt > p.pt) ud++;
      else if (v.pt < p.pt) ud--;
      n++;
    }
    rev.push(n > 0 ? sum / n : null);
    matched.push(n);
    upDown.push(n > 0 ? ud : null);
  }
  return { rev, matched, upDown };
}

/** Chain-linked trailing revision: Π(1 + r_j) − 1 over the window (null if empty). */
function trailingChainLink(series: Series, window: number): Series {
  return series.map((_, i) => {
    let prod = 1;
    let any = false;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = series[j];
      if (v == null || !Number.isFinite(v)) continue;
      prod *= 1 + v;
      any = true;
    }
    return any ? prod - 1 : null;
  });
}

/** Additive trailing sum over the window (null-aware; null if the window is empty). */
function trailingSum(series: Series, window: number): Series {
  return series.map((_, i) => {
    let s = 0;
    let any = false;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = series[j];
      if (v == null || !Number.isFinite(v)) continue;
      s += v;
      any = true;
    }
    return any ? s : null;
  });
}

/** Trailing mean over the window (used to normalize up/down counts by panel size). */
function trailingMean(series: number[], window: number): Series {
  return series.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      const v = series[j];
      if (v == null || !Number.isFinite(v)) continue;
      s += v;
      n++;
    }
    return n > 0 ? s / n : null;
  });
}

/** (#raising − #lowering) over the window / mean live panel size — a diffusion ratio. */
function upDownRatio(upDown: Series, matched: number[], window: number): Series {
  const num = trailingSum(upDown, window);
  const den = trailingMean(matched, window);
  return num.map((v, i) => {
    const d = den[i];
    return v == null || d == null || d < 1 ? null : v / d;
  });
}

/** Panel-size Bayesian shrinkage: r · n/(n+k) — pulls thin-panel revisions toward 0. */
function shrink(rev: Series, matched: number[], k: number): Series {
  return rev.map((v, i) => (v == null ? null : v * (matched[i]! / (matched[i]! + k))));
}

/** PT implied upside level: mean-panel target / close − 1. */
function impliedUpside(panels: PtPanel[], closes: Series): Series {
  return panels.map((p, i) => {
    const c = closes[i];
    if (p.size === 0 || c == null || c <= 0) return null;
    let s = 0;
    for (const v of p.values()) s += v.pt;
    return s / p.size / c - 1;
  });
}

/** Point-in-time per-analyst reco panels (latest score ≤ date, stale-evicted). */
function reconstructRecoPanels(events: RecoEventLike[], grid: string[], staleDays: number): Array<Map<string, { dateIso: string; score: number }>> {
  const sorted = [...events].sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  const latest = new Map<string, { dateIso: string; score: number }>();
  let lo = 0;
  const out: Array<Map<string, { dateIso: string; score: number }>> = [];
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.dateIso <= gridDate) {
      latest.set(sorted[lo]!.key, { dateIso: sorted[lo]!.dateIso, score: sorted[lo]!.score });
      lo++;
    }
    const cutoff = new Date(`${gridDate}T00:00:00Z`).getTime() - staleDays * DAY_MS;
    const panel = new Map<string, { dateIso: string; score: number }>();
    for (const [k, v] of latest) {
      if (new Date(`${v.dateIso}T00:00:00Z`).getTime() >= cutoff) panel.set(k, v);
    }
    out.push(panel);
  }
  return out;
}

/** Matched-panel recommendation change over the window (mean Δscore over analysts in both weeks). */
function recoMatchedChange(panels: Array<Map<string, { score: number }>>, window: number): Series {
  return panels.map((cur, i) => {
    if (i - window < 0) return null;
    const prev = panels[i - window]!;
    let sum = 0;
    let n = 0;
    for (const [k, v] of cur) {
      const p = prev.get(k);
      if (!p) continue;
      sum += v.score - p.score;
      n++;
    }
    return n > 0 ? sum / n : null;
  });
}

/**
 * Build every per-ticker candidate raw series. Keyed by candidate name; each is
 * a grid-length array. Cross-sectional candidates (orthogonalized, combos, gap)
 * are assembled later from these on the z-series layer.
 */
export function buildTickerCandidates(input: LabTickerInput, grid: string[], staleDays: number): Record<string, Series> {
  const m1 = weeklyPtMatched(input.panels);
  const capped = weeklyPtMatched(input.panels, 0.2);
  const recoPanels = reconstructRecoPanels(input.recoEvents, grid, staleDays);
  return {
    pt_matched_1w: m1.rev,
    pt_matched_4w: trailingChainLink(m1.rev, 4),
    pt_matched_13w: trailingChainLink(m1.rev, 13),
    pt_updown_4w: upDownRatio(m1.upDown, m1.matched, 4),
    pt_updown_13w: upDownRatio(m1.upDown, m1.matched, 13),
    pt_matched_1w_cap20: capped.rev,
    pt_matched_1w_shrink3: shrink(m1.rev, m1.matched, 3),
    pt_implied_upside: impliedUpside(input.panels, input.closes),
    rating_net_1w: input.netUpDown.map((v) => (Number.isFinite(v) ? v : null)),
    rating_net_4w: trailingSum(input.netUpDown, 4),
    rating_net_13w: trailingSum(input.netUpDown, 13),
    reco_matched_4w: recoMatchedChange(recoPanels, 4),
    reco_matched_13w: recoMatchedChange(recoPanels, 13),
  };
}

/** Candidate names that this lib produces per ticker (before cross-sectional combos). */
export const BASE_CANDIDATES = [
  "pt_matched_1w",
  "pt_matched_4w",
  "pt_matched_13w",
  "pt_updown_4w",
  "pt_updown_13w",
  "pt_matched_1w_cap20",
  "pt_matched_1w_shrink3",
  "pt_implied_upside",
  "rating_net_1w",
  "rating_net_4w",
  "rating_net_13w",
  "reco_matched_4w",
  "reco_matched_13w",
] as const;

// ---------------------------------------------------------------------------
// Cross-sectional (z-series) layer
// ---------------------------------------------------------------------------

/** Peer-relative z-score of a raw candidate, per week (mirrors production scoring). */
export function peerZSeries(raw: SeriesByTicker, tickers: string[], peerOf: Map<string, string>, gridLen: number): SeriesByTicker {
  const out: SeriesByTicker = new Map(tickers.map((t) => [t, new Array<number | null>(gridLen).fill(null)]));
  for (let w = 0; w < gridLen; w++) {
    const buckets = new Map<string, number[]>();
    tickers.forEach((t, i) => {
      const k = peerOf.get(t) ?? "Unclassified";
      const arr = buckets.get(k);
      if (arr) arr.push(i);
      else buckets.set(k, [i]);
    });
    for (const idxs of buckets.values()) {
      const sub = idxs.map((i) => raw.get(tickers[i]!)?.[w] ?? null);
      const { z } = zScores(sub);
      for (const [local, zv] of z) out.get(tickers[idxs[local]!]!)![w] = zv;
    }
  }
  return out;
}

/** Cross-sectional residual of a z-series after regressing it on a control z-series each week. */
export function orthogonalizeZ(sigZ: SeriesByTicker, ctrlZ: SeriesByTicker, tickers: string[], gridLen: number): SeriesByTicker {
  const out: SeriesByTicker = new Map(tickers.map((t) => [t, new Array<number | null>(gridLen).fill(null)]));
  for (let w = 0; w < gridLen; w++) {
    const xs: number[] = [];
    const ys: number[] = [];
    const idx: string[] = [];
    for (const t of tickers) {
      const a = sigZ.get(t)?.[w];
      const b = ctrlZ.get(t)?.[w];
      if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) {
        ys.push(a);
        xs.push(b);
        idx.push(t);
      }
    }
    if (xs.length < 3) continue;
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    for (let k = 0; k < xs.length; k++) {
      cov += (xs[k]! - mx) * (ys[k]! - my);
      vx += (xs[k]! - mx) ** 2;
    }
    const beta = vx > 1e-12 ? cov / vx : 0;
    idx.forEach((t, k) => {
      out.get(t)![w] = ys[k]! - my - beta * (xs[k]! - mx);
    });
  }
  return out;
}

/** Weighted blend of component z-series (e.g. equal-weight, IC-weighted, or gap [+1,−1]). */
export function comboZ(components: Array<{ z: SeriesByTicker; weight: number }>, tickers: string[], gridLen: number): SeriesByTicker {
  const out: SeriesByTicker = new Map(tickers.map((t) => [t, new Array<number | null>(gridLen).fill(null)]));
  for (const t of tickers) {
    const dst = out.get(t)!;
    for (let w = 0; w < gridLen; w++) {
      let sum = 0;
      let wsum = 0;
      for (const c of components) {
        const v = c.z.get(t)?.[w];
        if (v == null || !Number.isFinite(v)) continue;
        sum += v * c.weight;
        wsum += Math.abs(c.weight);
      }
      dst[w] = wsum > 0 ? sum / wsum : null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PeriodStats {
  weeks: number;
  meanIC: number | null;
  nwT: number | null;
  iidT: number | null;
  effWeeks: number | null;
  d10d1: number | null;
  monotonic: number | null; // Spearman(decile index, decile mean fwd)
  pooledObs: number;
}

export interface HorizonReport {
  horizonWeeks: number;
  train: PeriodStats;
  test: PeriodStats;
  byYear: Array<{ year: number; meanIC: number | null; weeks: number }>;
  signalAutocorr: number | null; // mean week-to-week rank persistence of the signal
  coverage: number; // mean names with a signal per week
}

function periodStats(weekly: Array<{ ic: number | null }>, pooled: SignalReturnPair[], horizonWeeks: number): PeriodStats {
  const ics = weekly.map((w) => w.ic);
  const nw = neweyWestTStat(ics, Math.max(0, horizonWeeks - 1));
  const finite = ics.filter((v): v is number => v != null && Number.isFinite(v));
  const iidMean = finite.length ? mean(finite) : null;
  let iidT: number | null = null;
  if (finite.length >= 2 && iidMean != null) {
    const varr = finite.reduce((a, b) => a + (b - iidMean) ** 2, 0) / (finite.length - 1);
    const se = Math.sqrt(varr / finite.length);
    iidT = se > 1e-12 ? iidMean / se : null;
  }
  const dec = decileForwardStats(pooled);
  const decPairs = dec.buckets.filter((b) => b.meanFwd != null);
  const monotonic = decPairs.length >= 3 ? spearman(decPairs.map((b) => b.decile), decPairs.map((b) => b.meanFwd!)) : null;
  return {
    weeks: finite.length,
    meanIC: nw.mean,
    nwT: nw.tStat,
    iidT,
    effWeeks: nw.effectiveN,
    d10d1: dec.d10d1,
    monotonic,
    pooledObs: pooled.length,
  };
}

/**
 * Evaluate one z-series candidate at one horizon. `forward[w]` maps ticker → the
 * peer-relative forward return over `horizonWeeks` starting at grid week w
 * (weeks whose forward endpoint hasn't printed are absent). Weeks are split
 * train (date ≤ trainEndIso) / test (date > trainEndIso); test is the headline.
 */
export function evaluateZSeries(
  zByTicker: SeriesByTicker,
  tickers: string[],
  grid: string[],
  forward: Array<Map<string, number>>,
  horizonWeeks: number,
  trainEndIso: string,
  trainStartIso?: string,
): HorizonReport {
  const weekly: Array<{ date: string; ic: number | null; pairs: SignalReturnPair[]; coverage: number }> = [];
  for (let w = 0; w < grid.length; w++) {
    const fwd = forward[w];
    const pairs: SignalReturnPair[] = [];
    let coverage = 0;
    if (fwd) {
      for (const t of tickers) {
        const z = zByTicker.get(t)?.[w];
        if (z == null || !Number.isFinite(z)) continue;
        coverage++;
        const r = fwd.get(t);
        if (r !== undefined) pairs.push({ signal: z, forwardReturn: r });
      }
    }
    weekly.push({ date: grid[w]!, ic: pairs.length >= 3 ? spearmanIC(pairs) : null, pairs, coverage });
  }

  const train = weekly.filter((w) => w.date <= trainEndIso && (!trainStartIso || w.date > trainStartIso) && w.ic != null);
  const test = weekly.filter((w) => w.date > trainEndIso && w.ic != null);
  const trainStats = periodStats(train, train.flatMap((w) => w.pairs), horizonWeeks);
  const testStats = periodStats(test, test.flatMap((w) => w.pairs), horizonWeeks);

  const byYearMap = new Map<number, number[]>();
  for (const w of weekly) {
    if (w.ic == null) continue;
    const y = Number(w.date.slice(0, 4));
    const arr = byYearMap.get(y);
    if (arr) arr.push(w.ic);
    else byYearMap.set(y, [w.ic]);
  }
  const byYear = [...byYearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, ics]) => ({ year, meanIC: ics.length ? mean(ics) : null, weeks: ics.length }));

  // Signal autocorrelation: mean week-to-week Spearman of the z ranking.
  const acs: number[] = [];
  for (let w = 1; w < grid.length; w++) {
    const a: number[] = [];
    const b: number[] = [];
    for (const t of tickers) {
      const cur = zByTicker.get(t)?.[w];
      const prev = zByTicker.get(t)?.[w - 1];
      if (cur != null && prev != null && Number.isFinite(cur) && Number.isFinite(prev)) {
        a.push(cur);
        b.push(prev);
      }
    }
    if (a.length >= 5) {
      const s = spearman(a, b);
      if (s != null) acs.push(s);
    }
  }
  const signalAutocorr = acs.length ? mean(acs) : null;
  const covWeeks = weekly.filter((w) => w.coverage > 0);
  const coverage = covWeeks.length ? mean(covWeeks.map((w) => w.coverage)) : 0;

  return { horizonWeeks, train: trainStats, test: testStats, byYear, signalAutocorr, coverage };
}

/** Fiscal-year-roll diagnostic: share of ticker-weeks whose forward fiscal period changed. */
export function rollWeekShare(
  forwardFiscalByTicker: Map<string, Array<string | null>>,
): { rollWeeks: number; totalTransitions: number } {
  let rollWeeks = 0;
  let total = 0;
  for (const series of forwardFiscalByTicker.values()) {
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1];
      const b = series[i];
      if (a == null || b == null) continue;
      total++;
      if (a !== b) rollWeeks++;
    }
  }
  return { rollWeeks, totalTransitions: total };
}
