/**
 * Engine 2 — pure inflection signal math. No I/O. Operates on a per-ticker
 * chronological (oldest -> newest) series of a metric. The engine detects where
 * the business is *changing* (second-derivative / trend-change), so most
 * signals are slope-of-slope or recent-vs-prior comparisons. All return null
 * when there is insufficient history rather than fabricating a value.
 *
 * Seasonality is handled by the caller feeding TTM-smoothed margin series and
 * year-over-year growth series; these functions are series-shape-agnostic.
 */

export function mean(xs: number[]): number | null {
  const f = xs.filter((x) => Number.isFinite(x));
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

export function stdev(xs: number[]): number | null {
  const f = xs.filter((x) => Number.isFinite(x));
  if (f.length < 2) return null;
  const m = f.reduce((a, b) => a + b, 0) / f.length;
  const v = f.reduce((a, b) => a + (b - m) ** 2, 0) / f.length;
  return Math.sqrt(v);
}

/** OLS slope of a contiguous series vs its index (0..n-1). Null if < 2 points. */
export function slope(ys: number[]): number | null {
  const f = ys.filter((y) => Number.isFinite(y));
  const n = f.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = f.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    cov += dx * (f[i]! - my);
    varx += dx * dx;
  }
  if (varx < 1e-12) return null;
  return cov / varx;
}

/** Finite values of a possibly-sparse series, in order (positions dropped). */
function finiteValues(series: Array<number | null>): number[] {
  return series.filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * Inflection = recent slope minus the prior slope (positive => the metric is
 * turning up after flat/down). Uses the last `window` finite points vs the
 * `window` before them. Null with fewer than 4 finite points.
 */
export function inflectionScore(series: Array<number | null>, window = 4): number | null {
  const f = finiteValues(series);
  if (f.length < 4) return null;
  const w = Math.min(window, Math.floor(f.length / 2));
  const recent = f.slice(-w);
  const prior = f.slice(-2 * w, -w);
  const rs = slope(recent);
  const ps = slope(prior);
  if (rs === null || ps === null) return null;
  return rs - ps;
}

/** Trend = OLS slope over the last `window` finite points (positive => rising). */
export function trendSlope(series: Array<number | null>, window = 8): number | null {
  const f = finiteValues(series);
  if (f.length < 3) return null;
  return slope(f.slice(-window));
}

/** Period-over-period (lag-`lag`) relative change series, guarded denominators. */
export function growthRates(levels: Array<number | null>, lag = 1): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < levels.length; i++) {
    const cur = levels[i];
    const prev = levels[i - lag];
    if (cur === null || prev === null || cur === undefined || prev === undefined) {
      out.push(null);
      continue;
    }
    const denom = Math.abs(prev);
    out.push(denom < 1e-9 ? null : (cur - prev) / denom);
  }
  return out;
}

/**
 * Growth acceleration = slope of the growth-rate series over the last `window`
 * finite points (positive => growth is accelerating, a positive 2nd derivative).
 */
export function accelerationScore(growth: Array<number | null>, window = 4): number | null {
  const f = finiteValues(growth);
  if (f.length < 3) return null;
  return slope(f.slice(-window));
}

export interface InflectionInputs {
  /** TTM gross margin series (oldest -> newest). */
  grossMargin: Array<number | null>;
  /** TTM EBITDA margin series. */
  ebitdaMargin: Array<number | null>;
  /** Year-over-year revenue growth series. */
  revenueGrowthYoy: Array<number | null>;
  /** TTM free-cash-flow (or FCF-margin) series. */
  fcf: Array<number | null>;
  /** ROIC series. */
  roic: Array<number | null>;
  /** Net-debt / EBITDA series. */
  netDebtToEbitda: Array<number | null>;
}

export interface InflectionSignals {
  grossMarginInflection: number | null;
  ebitdaMarginInflection: number | null;
  revenueGrowthAccel: number | null;
  fcfInflection: number | null;
  roicTrend: number | null;
  /** Positive => deleveraging (net-debt/EBITDA falling). */
  deleveraging: number | null;
}

/** Compute the full inflection signal set for one ticker's series bundle. */
export function computeInflectionSignals(s: InflectionInputs): InflectionSignals {
  const delSlope = trendSlope(s.netDebtToEbitda);
  return {
    grossMarginInflection: inflectionScore(s.grossMargin),
    ebitdaMarginInflection: inflectionScore(s.ebitdaMargin),
    revenueGrowthAccel: accelerationScore(s.revenueGrowthYoy),
    fcfInflection: inflectionScore(s.fcf),
    roicTrend: trendSlope(s.roic),
    deleveraging: delSlope === null ? null : -delSlope,
  };
}

/** The inflection signals that compose the cross-sectional discovery composite. */
export const INFLECTION_SIGNALS: Array<keyof InflectionSignals> = [
  "grossMarginInflection",
  "ebitdaMarginInflection",
  "revenueGrowthAccel",
  "fcfInflection",
  "roicTrend",
  "deleveraging",
];
