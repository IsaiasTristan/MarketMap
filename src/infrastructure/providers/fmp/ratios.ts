/**
 * Engine 2 — FMP pre-computed ratios + key-metrics. Stored alongside our own
 * derived figures (verify-before-trust: Phase 0 reconciles FMP's formulas
 * against ours before any signal relies on these). Defensive parsing.
 */
import { fmpGetJson, isoDate, num } from "./fmp-client";
import type {
  FmpEstimatePeriod,
  FmpKeyMetricsRaw,
  FmpRatiosRaw,
  NormalizedKeyMetrics,
  NormalizedRatios,
} from "./types";

export async function fetchRatios(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<NormalizedRatios[]> {
  const rows = await fmpGetJson<FmpRatiosRaw[]>("/stable/ratios", { symbol, period, limit });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): NormalizedRatios | null => {
      const fiscalDate = isoDate(r.date);
      if (!fiscalDate) return null;
      return {
        fiscalDate,
        grossMargin: num(r.grossProfitMargin),
        ebitdaMargin: num(r.ebitdaMargin),
        operatingMargin: num(r.operatingProfitMargin),
        netMargin: num(r.netProfitMargin),
        roe: num(r.returnOnEquity),
        roic: num(r.returnOnInvestedCapital) ?? num(r.returnOnCapitalEmployed),
        peRatio: num(r.priceToEarningsRatio),
        priceToSales: num(r.priceToSalesRatio),
        evToEbitda: num(r.evToEBITDA) ?? num(r.enterpriseValueMultiple),
        debtToEquity: num(r.debtToEquityRatio),
        netDebtToEbitda: num(r.netDebtToEBITDA),
      };
    })
    .filter((r): r is NormalizedRatios => r !== null)
    .sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
}

export async function fetchKeyMetrics(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<NormalizedKeyMetrics[]> {
  const rows = await fmpGetJson<FmpKeyMetricsRaw[]>("/stable/key-metrics", { symbol, period, limit });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): NormalizedKeyMetrics | null => {
      const fiscalDate = isoDate(r.date);
      if (!fiscalDate) return null;
      return {
        fiscalDate,
        marketCap: num(r.marketCap),
        enterpriseValue: num(r.enterpriseValue),
        evToEbitda: num(r.evToEBITDA) ?? num(r.enterpriseValueOverEBITDA),
        evToSales: num(r.evToSales),
        roic: num(r.returnOnInvestedCapital),
        fcfYield: num(r.freeCashFlowYield),
        netDebtToEbitda: num(r.netDebtToEBITDA),
      };
    })
    .filter((r): r is NormalizedKeyMetrics => r !== null)
    .sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
}
