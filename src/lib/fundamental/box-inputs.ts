/**
 * Engine 2 — pure assembly of a ticker's flat box-component map from a fully
 * loaded input bundle. No I/O: the scoring service loads statements / prices /
 * estimates / surprises and hands a `BoxInputBundle` here; this returns the
 * `${box}.${component}` -> oriented-raw map consumed by the two-level scorer.
 * Keeping the wiring pure makes the box -> component mapping unit-testable and
 * the whole pipeline deterministic.
 */
import { computeInflectionSignals, type InflectionSignals } from "./inflection";
import { surpriseComponents, type ReportedVsExpected } from "./surprise";
import { residualMomentumComponents } from "./residual-momentum";
import { cashQualityComponents } from "./cash-quality";
import { persistenceComponents } from "./persistence";
import { balanceSheetComponents } from "./balance-sheet";
import { valuationBoxComponents } from "./valuation-box";
import {
  forecastConfidenceComponents,
  type EstimateTriple,
} from "./forecast-confidence";
import { dilutionComponents } from "./dilution";
import { flatKey, type BoxKey } from "./boxes";
import type { MetricSeries } from "./series";

export interface BoxTtmSums {
  ebitda: number | null;
  interestExpense: number | null;
  cfo: number | null;
  capex: number | null;
  netIncome: number | null;
  sbc: number | null;
  changeInWorkingCapital: number | null;
  commonStockIssued: number | null;
  commonStockRepurchased: number | null;
  revenue: number | null;
  fcf: number | null;
}

export interface BoxCurrent {
  netDebtToEbitda: number | null;
  cash: number | null;
  totalDebt: number | null;
  totalEquity: number | null;
  evToEbitda: number | null;
  peRatio: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
  marketCap: number | null;
}

export interface BoxForecastInputs {
  eps: EstimateTriple | null;
  revenue: EstimateTriple | null;
  ebitda: EstimateTriple | null;
  priorEpsDispersion: number | null;
  numAnalystsEps: number | null;
  numAnalystsRevenue: number | null;
  epsSurpriseHistory: number[];
}

export interface BoxInputBundle {
  series: MetricSeries;
  ttm: BoxTtmSums;
  current: BoxCurrent;
  dilutedShares: Array<number | null>;
  avgTotalAssets: number | null;
  surprises: { eps: ReportedVsExpected[]; revenue: ReportedVsExpected[] };
  residual: { residual6m1m: number | null; residualSinceEarnings: number | null };
  forecast: BoxForecastInputs;
}

/** The inflection signals (box 1) computed from the smoothed series. */
export function inflectionFromSeries(series: MetricSeries): InflectionSignals {
  return computeInflectionSignals({
    grossMargin: series.ttmGrossMargin,
    ebitdaMargin: series.ttmEbitdaMargin,
    revenueGrowthYoy: series.revenueGrowthYoy,
    fcf: series.ttmFcf,
    roic: series.roic,
    netDebtToEbitda: series.netDebtToEbitda,
  });
}

/** Build the flat `${box}.${component}` -> oriented raw value map for one ticker. */
export function buildBoxComponents(b: BoxInputBundle): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const put = (box: BoxKey, obj: Record<string, number | null>) => {
    for (const [k, v] of Object.entries(obj)) out[flatKey(box, k)] = v;
  };

  const inflection = inflectionFromSeries(b.series);
  put("inflection", inflection as unknown as Record<string, number | null>);

  put("surprise", surpriseComponents(b.surprises));

  put("residualMomentum", residualMomentumComponents(b.residual));

  put(
    "cashQuality",
    cashQualityComponents({
      cfoTtm: b.ttm.cfo,
      capexTtm: b.ttm.capex,
      ebitdaTtm: b.ttm.ebitda,
      netIncomeTtm: b.ttm.netIncome,
      avgTotalAssets: b.avgTotalAssets,
      changeInWorkingCapitalTtm: b.ttm.changeInWorkingCapital,
    }),
  );

  put(
    "persistence",
    persistenceComponents({
      revenueGrowthYoy: b.series.revenueGrowthYoy,
      grossMargin: b.series.ttmGrossMargin,
      ebitdaMargin: b.series.ttmEbitdaMargin,
      fcfMargin: b.series.ttmFcfMargin,
      roic: b.series.roic,
      netDebtToEbitda: b.series.netDebtToEbitda,
    }),
  );

  put(
    "balanceSheet",
    balanceSheetComponents({
      netDebtToEbitda: b.current.netDebtToEbitda,
      ebitdaTtm: b.ttm.ebitda,
      interestExpenseTtm: b.ttm.interestExpense,
      cash: b.current.cash,
      fcfTtm: b.ttm.fcf,
      totalDebt: b.current.totalDebt,
    }),
  );

  put(
    "valuation",
    valuationBoxComponents({
      evToEbitda: b.current.evToEbitda,
      peRatio: b.current.peRatio,
      fcfYield: b.current.fcfYield,
      dividendYield: b.current.dividendYield,
    }),
  );

  put("forecastConfidence", forecastConfidenceComponents(b.forecast));

  put(
    "dilution",
    dilutionComponents({
      dilutedShares: b.dilutedShares,
      commonStockIssuedTtm: b.ttm.commonStockIssued,
      commonStockRepurchasedTtm: b.ttm.commonStockRepurchased,
      sbcTtm: b.ttm.sbc,
      revenueTtm: b.ttm.revenue,
      avgMarketCap: b.current.marketCap,
    }),
  );

  return out;
}
