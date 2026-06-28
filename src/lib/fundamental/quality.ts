/**
 * Engine 2 — pure quality-filter math. No I/O. These signals KILL bad ideas
 * (value traps) rather than generate buys:
 *  - accruals: net income running ahead of cash flow is the classic trap tell;
 *  - compounder: high AND stable ROIC over years is the durable-quality tell.
 *
 * Requires actual cash-flow OCF (not estimates). Phase 0 confirmed OCF + capex
 * are covered on small-caps; where OCF is genuinely missing the accruals signal
 * returns null (never zero-filled), so it degrades silently to "no opinion"
 * instead of a false clean reading.
 */
import { mean, slope, stdev } from "./inflection";

/**
 * Sloan-style accruals ratio = (netIncome - operatingCashFlow) / avgTotalAssets.
 * Higher (more positive) => earnings are less cash-backed => lower quality.
 */
export function accrualsRatio(
  netIncome: number | null,
  operatingCashFlow: number | null,
  avgTotalAssets: number | null,
): number | null {
  if (netIncome === null || operatingCashFlow === null || avgTotalAssets === null) return null;
  if (!Number.isFinite(avgTotalAssets) || Math.abs(avgTotalAssets) < 1e-6) return null;
  return (netIncome - operatingCashFlow) / Math.abs(avgTotalAssets);
}

/**
 * Accruals divergence = NI growth minus CFO growth over the trailing series.
 * Large positive => net income is outrunning cash generation (trap risk).
 * Uses the slope of each series' last `window` finite points as the growth read.
 */
export function accrualsDivergence(
  netIncomeSeries: Array<number | null>,
  operatingCashFlowSeries: Array<number | null>,
  window = 8,
): number | null {
  const ni = netIncomeSeries.filter((v): v is number => v !== null && Number.isFinite(v)).slice(-window);
  const cfo = operatingCashFlowSeries
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .slice(-window);
  const niSlope = slope(ni);
  const cfoSlope = slope(cfo);
  if (niSlope === null || cfoSlope === null) return null;
  // Normalize each slope by the average level so cross-company magnitudes are
  // comparable, then take the gap.
  const niBase = mean(ni);
  const cfoBase = mean(cfo);
  if (niBase === null || cfoBase === null) return null;
  const niN = Math.abs(niBase) < 1e-6 ? niSlope : niSlope / Math.abs(niBase);
  const cfoN = Math.abs(cfoBase) < 1e-6 ? cfoSlope : cfoSlope / Math.abs(cfoBase);
  return niN - cfoN;
}

export interface TrapInputs {
  accrualsRatio: number | null;
  accrualsDivergence: number | null;
}

/**
 * Trap flag: raised when accruals quality is poor on either measure. Conservative
 * defaults (a high accruals ratio OR clearly diverging NI-vs-cash). Null inputs
 * never raise the flag.
 */
export function trapFlag(
  inputs: TrapInputs,
  thresholds: { ratio?: number; divergence?: number } = {},
): boolean {
  const ratioT = thresholds.ratio ?? 0.1;
  const divT = thresholds.divergence ?? 0.15;
  const ratioBad = inputs.accrualsRatio !== null && inputs.accrualsRatio > ratioT;
  const divBad = inputs.accrualsDivergence !== null && inputs.accrualsDivergence > divT;
  return ratioBad || divBad;
}

export interface Compounder {
  /** Mean ROIC over the window. */
  level: number | null;
  /** ROIC standard deviation (lower => more consistent). */
  volatility: number | null;
  /** Consistency in [0,1] (1 = perfectly stable). */
  consistency: number | null;
  /** Combined score: level penalized by inconsistency. */
  score: number | null;
}

/**
 * Compounder read: high AND stable ROIC over the years. Returns level (mean),
 * volatility (stdev), a [0,1] consistency, and a combined score. Needs >= 4
 * finite ROIC points.
 */
export function compounder(roicSeries: Array<number | null>): Compounder {
  const f = roicSeries.filter((v): v is number => v !== null && Number.isFinite(v));
  if (f.length < 4) return { level: null, volatility: null, consistency: null, score: null };
  const level = mean(f)!;
  const vol = stdev(f) ?? 0;
  // Consistency: 1 when stdev is 0, decaying as dispersion relative to |level| grows.
  const denom = Math.max(Math.abs(level), 1e-6);
  const consistency = 1 / (1 + vol / denom);
  const score = level * consistency;
  return { level, volatility: vol, consistency, score };
}
