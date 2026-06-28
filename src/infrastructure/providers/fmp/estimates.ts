/** Leg A — analyst estimates (forward consensus). Current consensus only. */
import { fmpGetJson, num } from "./fmp-client";
import type {
  EstimateTriple,
  FmpAnalystEstimateRaw,
  FmpEstimatePeriod,
  NormalizedEstimatePeriod,
} from "./types";

function triple(low: unknown, avg: unknown, high: unknown): EstimateTriple {
  return { low: num(low), avg: num(avg), high: num(high) };
}

function normalize(r: FmpAnalystEstimateRaw): NormalizedEstimatePeriod {
  return {
    fiscalDate: r.date,
    revenue: triple(r.revenueLow, r.revenueAvg, r.revenueHigh),
    ebitda: triple(r.ebitdaLow, r.ebitdaAvg, r.ebitdaHigh),
    ebit: triple(r.ebitLow, r.ebitAvg, r.ebitHigh),
    netIncome: triple(r.netIncomeLow, r.netIncomeAvg, r.netIncomeHigh),
    sga: triple(r.sgaExpenseLow, r.sgaExpenseAvg, r.sgaExpenseHigh),
    eps: triple(r.epsLow, r.epsAvg, r.epsHigh),
    numAnalystsRevenue: num(r.numAnalystsRevenue),
    numAnalystsEps: num(r.numAnalystsEps),
  };
}

export async function fetchAnalystEstimates(
  symbol: string,
  period: FmpEstimatePeriod = "annual",
  limit = 16,
): Promise<NormalizedEstimatePeriod[]> {
  const rows = await fmpGetJson<FmpAnalystEstimateRaw[]>("/stable/analyst-estimates", {
    symbol,
    period,
    limit,
  });
  if (!Array.isArray(rows)) return [];
  return rows.map(normalize).sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
}
