/**
 * Engine 1 — pure backtest math for Leg B. Given (signal, forwardReturn) pairs,
 * compute the information coefficient (rank-free Pearson) and the long-short
 * quantile spread. No I/O. Used by scripts/revision-legb-backtest.ts to make
 * the initial leg weighting evidence-based at launch.
 */

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
