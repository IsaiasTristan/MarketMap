/**
 * Engine 1 — pure backtest / validation math. Given (signal, forwardReturn)
 * pairs, compute information coefficients (Pearson and Spearman rank),
 * long-short quantile spreads, decile forward-return stats, rolling ICs, and
 * post-flag drift. No I/O. Used by scripts/revision-legb-backtest.ts and the
 * validation tab service. Every window clamps to available history and
 * surfaces the effective count.
 */
import { rankAndDecile } from "@/lib/revision/scoring";

export interface SignalReturnPair {
  signal: number;
  forwardReturn: number;
}

/** Pearson correlation of two equal-length finite series, or null. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx < 1e-12 || vy < 1e-12) return null;
  return cov / Math.sqrt(vx * vy);
}

export function informationCoefficient(pairs: SignalReturnPair[]): number | null {
  return pearson(
    pairs.map((p) => p.signal),
    pairs.map((p) => p.forwardReturn),
  );
}

export interface QuantileSpread {
  n: number;
  topMean: number | null;
  bottomMean: number | null;
  spread: number | null;
}

/** Mean forward return of the top vs bottom signal quantile (default tertile). */
export function quantileSpread(pairs: SignalReturnPair[], q = 1 / 3): QuantileSpread {
  const sorted = [...pairs].sort((a, b) => a.signal - b.signal);
  const n = sorted.length;
  if (n < 6) return { n, topMean: null, bottomMean: null, spread: null };
  const k = Math.max(1, Math.floor(n * q));
  const mean = (arr: SignalReturnPair[]) =>
    arr.reduce((s, p) => s + p.forwardReturn, 0) / arr.length;
  const bottomMean = mean(sorted.slice(0, k));
  const topMean = mean(sorted.slice(n - k));
  return { n, topMean, bottomMean, spread: topMean - bottomMean };
}

/** Map an FMP grade action string to a directional score (+1 / -1 / 0). */
export function actionScore(action: string | null): number {
  if (!action) return 0;
  const a = action.toLowerCase();
  if (a.includes("up")) return 1;
  if (a.includes("down")) return -1;
  return 0;
}

/** Forward simple return between the first bar on/after `fromIdx` and `fromIdx + horizon`. */
export function forwardReturnAt(
  closes: number[],
  fromIdx: number,
  horizon: number,
): number | null {
  const toIdx = fromIdx + horizon;
  if (fromIdx < 0 || toIdx >= closes.length) return null;
  const a = closes[fromIdx]!;
  const b = closes[toIdx]!;
  if (a <= 0) return null;
  return b / a - 1;
}

/** Tie-averaged ranks (1-based). [10, 20, 20, 30] -> [1, 2.5, 2.5, 4]. */
export function averageRanks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let k = 0;
  while (k < order.length) {
    let j = k;
    while (j + 1 < order.length && order[j + 1]!.v === order[k]!.v) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) ranks[order[m]!.i] = avg;
    k = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation = Pearson of tie-averaged ranks, or null. */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  return pearson(averageRanks(xs.slice(0, n)), averageRanks(ys.slice(0, n)));
}

/** Spearman rank IC of signal vs forward return. */
export function spearmanIC(pairs: SignalReturnPair[]): number | null {
  return spearman(
    pairs.map((p) => p.signal),
    pairs.map((p) => p.forwardReturn),
  );
}

export interface DecileBucket {
  decile: number; // 1..10, 10 = strongest signal
  n: number;
  meanFwd: number | null;
}

export interface DecileForwardStats {
  buckets: DecileBucket[]; // always 10 entries, decile ascending
  d10d1: number | null; // top-decile mean fwd minus bottom-decile mean fwd
  d10HitRate: number | null; // share of top-decile names with positive fwd return
  n: number;
}

/** Forward-return means by signal decile (reuses the production decile cut). */
export function decileForwardStats(pairs: SignalReturnPair[]): DecileForwardStats {
  const ranked = rankAndDecile(pairs.map((p) => p.signal));
  const byDecile = new Map<number, number[]>();
  for (const e of ranked) {
    const arr = byDecile.get(e.decile);
    const fwd = pairs[e.index]!.forwardReturn;
    if (arr) arr.push(fwd);
    else byDecile.set(e.decile, [fwd]);
  }
  const buckets: DecileBucket[] = [];
  for (let d = 1; d <= 10; d++) {
    const fwds = byDecile.get(d) ?? [];
    buckets.push({
      decile: d,
      n: fwds.length,
      meanFwd: fwds.length > 0 ? fwds.reduce((a, b) => a + b, 0) / fwds.length : null,
    });
  }
  const top = buckets[9]!;
  const bottom = buckets[0]!;
  const d10d1 = top.meanFwd !== null && bottom.meanFwd !== null ? top.meanFwd - bottom.meanFwd : null;
  const topFwds = byDecile.get(10) ?? [];
  const d10HitRate = topFwds.length > 0 ? topFwds.filter((f) => f > 0).length / topFwds.length : null;
  return { buckets, d10d1, d10HitRate, n: ranked.length };
}

export interface WeeklyPairs {
  date: string; // YYYY-MM-DD snapshot date
  pairs: SignalReturnPair[];
}

export interface RollingIcPoint {
  date: string;
  ic: number | null; // mean of the weekly ICs in the trailing window
  weeksUsed: number; // weekly ICs actually available in the window (clamped)
}

/**
 * Trailing-window mean of weekly cross-sectional ICs. The window CLAMPS to
 * whatever weeks exist, so a 2-week-old dataset still produces points —
 * `weeksUsed` tells the UI how much history each point really reflects.
 */
export function rollingIC(
  weekly: WeeklyPairs[],
  window = 4,
  method: "spearman" | "pearson" = "spearman",
): RollingIcPoint[] {
  const icOf = method === "spearman" ? spearmanIC : informationCoefficient;
  const weeklyIcs = weekly.map((w) => icOf(w.pairs));
  return weekly.map((w, i) => {
    const start = Math.max(0, i - window + 1);
    const inWindow = weeklyIcs.slice(start, i + 1).filter((v): v is number => v !== null);
    return {
      date: w.date,
      ic: inWindow.length > 0 ? inWindow.reduce((a, b) => a + b, 0) / inWindow.length : null,
      weeksUsed: inWindow.length,
    };
  });
}

/**
 * Mean drift per horizon across flagged events. `flagForwardReturns[e][h]` is
 * event e's forward return at horizon h (null where the future hasn't printed
 * yet). Returns one mean per horizon, null when no event has that horizon.
 */
export function meanDrift(flagForwardReturns: Array<Array<number | null>>): Array<number | null> {
  const horizons = flagForwardReturns.reduce((m, e) => Math.max(m, e.length), 0);
  const out: Array<number | null> = [];
  for (let h = 0; h < horizons; h++) {
    const vals = flagForwardReturns
      .map((e) => e[h] ?? null)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    out.push(vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }
  return out;
}

/** Mean, t-stat (mean / stderr), and n of a series of ICs. */
export function icSummary(ics: Array<number | null>): { mean: number | null; tStat: number | null; n: number } {
  const finite = ics.filter((v): v is number => v !== null && Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { mean: null, tStat: null, n };
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, tStat: null, n };
  const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stderr = Math.sqrt(variance / n);
  return { mean, tStat: stderr > 1e-12 ? mean / stderr : null, n };
}
