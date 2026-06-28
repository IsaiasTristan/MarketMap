import { describe, expect, it } from "vitest";
import { buildMetricSeries, lastFinite, type PeriodFacts } from "@/lib/fundamental/series";

function q(fiscalDate: string, revenue: number, grossProfit: number, ebitda: number): PeriodFacts {
  return {
    fiscalDate,
    revenue,
    grossProfit,
    operatingIncome: ebitda,
    netIncome: ebitda / 2,
    ebitda,
    freeCashFlow: ebitda / 3,
    operatingCashFlow: ebitda / 2,
    totalDebt: 200,
    cash: 50,
    totalAssets: 1000,
    roic: 0.1,
    peRatio: 15,
    evToEbitda: 10,
    priceToSales: 3,
  };
}

describe("buildMetricSeries", () => {
  const periods: PeriodFacts[] = [];
  for (let i = 0; i < 12; i++) {
    // revenue grows; gross profit a constant 40% of revenue -> flat TTM gross margin
    const rev = 100 + i * 10;
    periods.push(q(`20${20 + Math.floor(i / 4)}-0${(i % 4) * 3 + 1}-01`, rev, rev * 0.4, rev * 0.2));
  }
  const s = buildMetricSeries(periods);

  it("nulls TTM margins before 4 quarters are available", () => {
    expect(s.ttmGrossMargin[0]).toBeNull();
    expect(s.ttmGrossMargin[2]).toBeNull();
    expect(s.ttmGrossMargin[3]).not.toBeNull();
  });

  it("computes a stable ~40% TTM gross margin", () => {
    expect(lastFinite(s.ttmGrossMargin)!).toBeCloseTo(0.4, 3);
  });

  it("computes positive YoY revenue growth (4 quarters apart)", () => {
    expect(lastFinite(s.revenueGrowthYoy)!).toBeGreaterThan(0);
  });

  it("derives net-debt/EBITDA from line items", () => {
    // netDebt = 200 - 50 = 150; TTM ebitda = sum of 4 quarterly ebitda (positive) -> positive ratio
    expect(lastFinite(s.netDebtToEbitda)!).toBeGreaterThan(0);
  });
});

describe("lastFinite", () => {
  it("returns the last finite value skipping trailing nulls", () => {
    expect(lastFinite([1, 2, null])).toBe(2);
    expect(lastFinite([null, null])).toBeNull();
  });
});
