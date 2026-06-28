/**
 * Engine 2 — per-component underlying-metric series. Pure math, no I/O.
 *
 * For the discovery "composition" panel: each box component (e.g. Cash
 * Quality's FCF conversion) is scored from a single latest value, but users
 * want to see the trend of the data underneath it. This builds the last-~8
 * quarterly values of the underlying metric each derivable component is built
 * from, keyed by the flat `${box}.${component}` key used everywhere else.
 *
 * Inherently point-in-time components (Residual Momentum, Persistence,
 * Forecast Confidence) carry no series and are simply omitted from the map.
 */
import { flatKey } from "./boxes";
import type { MetricSeries } from "./series";
import { COVERAGE_CAP, RUNWAY_CAP } from "./balance-sheet";
import {
  surpriseRatio,
  EPS_DENOM_FLOOR,
  REVENUE_DENOM_FLOOR,
  type ReportedVsExpected,
} from "./surprise";

/** Raw quarterly facts (chronological, oldest -> newest) + already-smoothed series. */
export interface ComponentSeriesInputs {
  metric: MetricSeries;
  ebitda: Array<number | null>;
  operatingCashFlow: Array<number | null>;
  netIncome: Array<number | null>;
  totalAssets: Array<number | null>;
  changeInWorkingCapital: Array<number | null>;
  interestExpense: Array<number | null>;
  stockBasedCompensation: Array<number | null>;
  revenue: Array<number | null>;
  cash: Array<number | null>;
  totalDebt: Array<number | null>;
  commonStockIssued: Array<number | null>;
  commonStockRepurchased: Array<number | null>;
  dilutedShares: Array<number | null>;
  /** Per-period valuation fields not derivable from MetricSeries. */
  fcfYield: Array<number | null>;
  dividendYield: Array<number | null>;
  /** Per-report surprises (chronological, oldest -> newest). */
  epsSurprises: ReportedVsExpected[];
  revenueSurprises: ReportedVsExpected[];
}

const SERIES_LEN = 8;
const INTEREST_FLOOR = 1e-6;
const DEBT_FLOOR = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Trailing-4-quarter sum ending at i (null if i < 3 or any input null). */
function ttmSum(arr: Array<number | null>, i: number): number | null {
  if (i < 3) return null;
  let s = 0;
  for (let k = i - 3; k <= i; k++) {
    const v = arr[k];
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    s += v;
  }
  return s;
}

/** Average of the finite total-assets over the trailing 4 quarters ending at i. */
function avgTrailing(arr: Array<number | null>, i: number): number | null {
  if (i < 0) return null;
  const start = Math.max(0, i - 3);
  const vals: number[] = [];
  for (let k = start; k <= i; k++) {
    const v = arr[k];
    if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Map each index to a derived value (or null), preserving length. */
function map<T>(len: number, fn: (i: number) => number | null): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < len; i++) out.push(fn(i));
  return out;
}

/** Last `n` finite values (oldest -> newest). */
function last8Finite(series: Array<number | null>, n = SERIES_LEN): number[] {
  return series.filter((v): v is number => v !== null && Number.isFinite(v)).slice(-n);
}

function coverageAt(ebitda: number | null, interest: number | null): number | null {
  if (ebitda === null) return null;
  const mag = interest === null ? 0 : Math.abs(interest);
  if (mag < INTEREST_FLOOR) return ebitda > 0 ? COVERAGE_CAP : null;
  return clamp(ebitda / mag, -COVERAGE_CAP, COVERAGE_CAP);
}

function runwayAt(cash: number | null, fcf: number | null, debt: number | null): number | null {
  if (cash === null) return null;
  const cushion = cash + Math.max(fcf ?? 0, 0);
  const d = debt === null ? 0 : Math.abs(debt);
  if (d < DEBT_FLOOR) return cushion > 0 ? RUNWAY_CAP : 0;
  return clamp(cushion / d, 0, RUNWAY_CAP);
}

/**
 * Build the flat-key -> underlying-metric-series map for the derivable
 * components. Only keys with at least one finite point are included.
 */
export function buildComponentSeries(
  inputs: ComponentSeriesInputs,
): Record<string, number[]> {
  const m = inputs.metric;
  const len = m.dates.length;

  const ttmEbitda = map(len, (i) => ttmSum(inputs.ebitda, i));
  const ttmCfo = map(len, (i) => ttmSum(inputs.operatingCashFlow, i));
  const ttmNi = map(len, (i) => ttmSum(inputs.netIncome, i));
  const ttmWc = map(len, (i) => ttmSum(inputs.changeInWorkingCapital, i));
  const ttmInterest = map(len, (i) => ttmSum(inputs.interestExpense, i));
  const ttmSbc = map(len, (i) => ttmSum(inputs.stockBasedCompensation, i));
  const ttmRevenue = map(len, (i) => ttmSum(inputs.revenue, i));
  const ttmIssued = map(len, (i) => ttmSum(inputs.commonStockIssued, i));
  const ttmRepurchased = map(len, (i) => ttmSum(inputs.commonStockRepurchased, i));

  // Cash Quality.
  const fcfConversion = map(len, (i) => {
    const fcf = m.ttmFcf[i];
    const eb = ttmEbitda[i];
    if (fcf == null || eb == null || !(eb > 0)) return null;
    return fcf / eb;
  });
  const accrualsRatio = map(len, (i) => {
    const ni = ttmNi[i];
    const cfo = ttmCfo[i];
    const aa = avgTrailing(inputs.totalAssets, i);
    if (ni == null || cfo == null || aa == null || Math.abs(aa) < 1e-9) return null;
    return (ni - cfo) / aa;
  });
  const wcToCfo = map(len, (i) => {
    const wc = ttmWc[i];
    const cfo = ttmCfo[i];
    if (wc == null || cfo == null || Math.abs(cfo) < 1e-6) return null;
    return wc / Math.abs(cfo);
  });

  // Balance Sheet.
  const interestCoverage = map(len, (i) => coverageAt(ttmEbitda[i], ttmInterest[i]));
  const cashRunway = map(len, (i) => runwayAt(inputs.cash[i] ?? null, m.ttmFcf[i] ?? null, inputs.totalDebt[i] ?? null));

  // Dilution.
  const netIssuance = map(len, (i) => {
    const iss = ttmIssued[i];
    const rep = ttmRepurchased[i];
    if (iss == null && rep == null) return null;
    return (iss ?? 0) + (rep ?? 0);
  });
  const sbcToRevenue = map(len, (i) => {
    const sbc = ttmSbc[i];
    const rev = ttmRevenue[i];
    if (sbc == null || rev == null || !(rev > 0)) return null;
    return sbc / rev;
  });

  // Surprise (per report).
  const epsSurprise = inputs.epsSurprises.map((r) =>
    surpriseRatio(r.actual, r.expected, EPS_DENOM_FLOOR),
  );
  const revSurprise = inputs.revenueSurprises.map((r) =>
    surpriseRatio(r.actual, r.expected, REVENUE_DENOM_FLOOR),
  );

  const candidates: Array<[string, Array<number | null>]> = [
    // Inflection — the underlying smoothed metric each signal is the slope of.
    [flatKey("inflection", "grossMarginInflection"), m.ttmGrossMargin],
    [flatKey("inflection", "ebitdaMarginInflection"), m.ttmEbitdaMargin],
    [flatKey("inflection", "revenueGrowthAccel"), m.revenueGrowthYoy],
    [flatKey("inflection", "fcfInflection"), m.ttmFcf],
    [flatKey("inflection", "roicTrend"), m.roic],
    [flatKey("inflection", "deleveraging"), m.netDebtToEbitda],
    // Cash Quality.
    [flatKey("cashQuality", "fcfConversion"), fcfConversion],
    [flatKey("cashQuality", "accrualQuality"), accrualsRatio],
    [flatKey("cashQuality", "workingCapitalQuality"), wcToCfo],
    // Balance Sheet.
    [flatKey("balanceSheet", "netLeverageQuality"), m.netDebtToEbitda],
    [flatKey("balanceSheet", "interestCoverage"), interestCoverage],
    [flatKey("balanceSheet", "cashRunway"), cashRunway],
    // Valuation.
    [flatKey("valuation", "evEbitdaValue"), m.evToEbitda],
    [flatKey("valuation", "peValue"), m.peRatio],
    [flatKey("valuation", "fcfYieldValue"), inputs.fcfYield],
    [flatKey("valuation", "divYieldValue"), inputs.dividendYield],
    // Dilution.
    [flatKey("dilution", "shareGrowthQuality"), inputs.dilutedShares],
    [flatKey("dilution", "shareCagr2yQuality"), inputs.dilutedShares],
    [flatKey("dilution", "netIssuanceQuality"), netIssuance],
    [flatKey("dilution", "sbcQuality"), sbcToRevenue],
    // Surprise (per report, not per fiscal quarter).
    [flatKey("surprise", "latestEpsSurprise"), epsSurprise],
    [flatKey("surprise", "avg4EpsSurprise"), epsSurprise],
    [flatKey("surprise", "latestRevenueSurprise"), revSurprise],
    [flatKey("surprise", "avg4RevenueSurprise"), revSurprise],
  ];

  const out: Record<string, number[]> = {};
  for (const [key, series] of candidates) {
    const trimmed = last8Finite(series);
    if (trimmed.length >= 2) out[key] = trimmed;
  }
  return out;
}
