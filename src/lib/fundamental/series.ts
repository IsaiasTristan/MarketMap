/**
 * Engine 2 — pure series construction shared by ingestion (snapshot typed
 * fields) and scoring (signal inputs). Turns a chronological run of fiscal-
 * period facts into the smoothed series the signals consume: TTM margins
 * (seasonality-free), year-over-year growth, and per-period ROIC / leverage /
 * valuation-multiple series. No I/O.
 */

export interface PeriodFacts {
  fiscalDate: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null; // our derived = operatingIncome + D&A
  freeCashFlow: number | null; // our derived = OCF + capex
  operatingCashFlow: number | null;
  totalDebt: number | null;
  cash: number | null;
  totalAssets: number | null;
  roic: number | null;
  peRatio: number | null;
  evToEbitda: number | null;
  priceToSales: number | null;
}

export interface MetricSeries {
  dates: string[];
  ttmRevenue: Array<number | null>;
  ttmGrossMargin: Array<number | null>;
  ttmEbitdaMargin: Array<number | null>;
  ttmOperatingMargin: Array<number | null>;
  ttmNetMargin: Array<number | null>;
  ttmFcf: Array<number | null>;
  ttmFcfMargin: Array<number | null>;
  revenueGrowthYoy: Array<number | null>;
  roic: Array<number | null>;
  netDebtToEbitda: Array<number | null>;
  peRatio: Array<number | null>;
  evToEbitda: Array<number | null>;
  priceToSales: Array<number | null>;
  /** Raw level series retained for the accruals divergence (NI vs CFO). */
  netIncome: Array<number | null>;
  operatingCashFlow: Array<number | null>;
}

/** Sum of the 4 trailing quarters ending at index i, or null if any are missing. */
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

function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  return num / den;
}

/**
 * Build the smoothed metric series from quarterly period facts (chronological,
 * oldest -> newest). TTM margins remove seasonality; YoY growth compares TTM
 * revenue 4 quarters apart.
 */
export function buildMetricSeries(periods: PeriodFacts[]): MetricSeries {
  const dates = periods.map((p) => p.fiscalDate);
  const revenue = periods.map((p) => p.revenue);
  const grossProfit = periods.map((p) => p.grossProfit);
  const operatingIncome = periods.map((p) => p.operatingIncome);
  const netIncome = periods.map((p) => p.netIncome);
  const ebitda = periods.map((p) => p.ebitda);
  const fcf = periods.map((p) => p.freeCashFlow);
  const ocf = periods.map((p) => p.operatingCashFlow);

  const ttmRevenue: Array<number | null> = [];
  const ttmGrossMargin: Array<number | null> = [];
  const ttmEbitdaMargin: Array<number | null> = [];
  const ttmOperatingMargin: Array<number | null> = [];
  const ttmNetMargin: Array<number | null> = [];
  const ttmFcf: Array<number | null> = [];
  const ttmFcfMargin: Array<number | null> = [];
  const netDebtToEbitda: Array<number | null> = [];

  for (let i = 0; i < periods.length; i++) {
    const rev = ttmSum(revenue, i);
    const ebitdaTtm = ttmSum(ebitda, i);
    ttmRevenue.push(rev);
    ttmGrossMargin.push(ratio(ttmSum(grossProfit, i), rev));
    ttmEbitdaMargin.push(ratio(ebitdaTtm, rev));
    ttmOperatingMargin.push(ratio(ttmSum(operatingIncome, i), rev));
    ttmNetMargin.push(ratio(ttmSum(netIncome, i), rev));
    const fcfTtm = ttmSum(fcf, i);
    ttmFcf.push(fcfTtm);
    ttmFcfMargin.push(ratio(fcfTtm, rev));
    const td = periods[i]!.totalDebt;
    const cash = periods[i]!.cash;
    const netDebt = td !== null && cash !== null ? td - cash : null;
    netDebtToEbitda.push(ratio(netDebt, ebitdaTtm));
  }

  const revenueGrowthYoy: Array<number | null> = ttmRevenue.map((cur, i) => {
    const prev = ttmRevenue[i - 4];
    if (cur === null || prev === null || prev === undefined || Math.abs(prev) < 1e-9) return null;
    return cur / prev - 1;
  });

  return {
    dates,
    ttmRevenue,
    ttmGrossMargin,
    ttmEbitdaMargin,
    ttmOperatingMargin,
    ttmNetMargin,
    ttmFcf,
    ttmFcfMargin,
    revenueGrowthYoy,
    roic: periods.map((p) => p.roic),
    netDebtToEbitda,
    peRatio: periods.map((p) => p.peRatio),
    evToEbitda: periods.map((p) => p.evToEbitda),
    priceToSales: periods.map((p) => p.priceToSales),
    netIncome,
    operatingCashFlow: ocf,
  };
}

/** Last finite value of a series, or null. */
export function lastFinite(series: Array<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}
