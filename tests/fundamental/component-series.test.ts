import { describe, expect, it } from "vitest";
import {
  buildComponentSeries,
  type ComponentSeriesInputs,
} from "@/lib/fundamental/component-series";
import { flatKey } from "@/lib/fundamental/boxes";
import type { MetricSeries } from "@/lib/fundamental/series";

function fill(len: number, v: number): Array<number | null> {
  return Array.from({ length: len }, () => v);
}

function makeMetric(len: number): MetricSeries {
  return {
    dates: Array.from({ length: len }, (_, i) => `2024-Q${i}`),
    ttmRevenue: fill(len, 1000),
    ttmGrossMargin: Array.from({ length: len }, (_, i) => 0.4 + i * 0.01),
    ttmEbitdaMargin: fill(len, 0.2),
    ttmOperatingMargin: fill(len, 0.15),
    ttmNetMargin: fill(len, 0.1),
    ttmFcf: fill(len, 50),
    ttmFcfMargin: fill(len, 0.05),
    revenueGrowthYoy: fill(len, 0.1),
    roic: fill(len, 0.12),
    netDebtToEbitda: fill(len, 1.5),
    peRatio: fill(len, 20),
    evToEbitda: fill(len, 10),
    priceToSales: fill(len, 3),
    netIncome: fill(len, 100),
    operatingCashFlow: fill(len, 120),
  };
}

function makeInputs(len = 10, overrides: Partial<ComponentSeriesInputs> = {}): ComponentSeriesInputs {
  return {
    metric: makeMetric(len),
    ebitda: fill(len, 25), // TTM = 100
    operatingCashFlow: fill(len, 30), // TTM = 120
    netIncome: fill(len, 25), // TTM = 100
    totalAssets: fill(len, 1000),
    changeInWorkingCapital: fill(len, 10),
    interestExpense: fill(len, 5), // TTM = 20
    stockBasedCompensation: fill(len, 5), // TTM = 20
    revenue: fill(len, 250), // TTM = 1000
    cash: fill(len, 200),
    totalDebt: fill(len, 100),
    commonStockIssued: fill(len, 8),
    commonStockRepurchased: fill(len, -2),
    dilutedShares: Array.from({ length: len }, (_, i) => 100 + i),
    fcfYield: fill(len, 0.06),
    dividendYield: fill(len, 0.02),
    epsSurprises: [
      { actual: 1.1, expected: 1.0 },
      { actual: 1.2, expected: 1.0 },
      { actual: 0.9, expected: 1.0 },
    ],
    revenueSurprises: [
      { actual: 110, expected: 100 },
      { actual: 95, expected: 100 },
    ],
    ...overrides,
  };
}

describe("buildComponentSeries", () => {
  it("computes FCF conversion = TTM FCF / TTM EBITDA", () => {
    const out = buildComponentSeries(makeInputs());
    const s = out[flatKey("cashQuality", "fcfConversion")]!;
    expect(s).toBeDefined();
    // ttmFcf 50 / ttmEbitda 100 = 0.5 on every populated quarter.
    expect(s.at(-1)!).toBeCloseTo(0.5, 9);
  });

  it("computes the raw accruals ratio (NI - CFO) / avg assets", () => {
    const out = buildComponentSeries(makeInputs());
    const s = out[flatKey("cashQuality", "accrualQuality")]!;
    // (100 - 120) / 1000 = -0.02
    expect(s.at(-1)!).toBeCloseTo(-0.02, 9);
  });

  it("builds a per-report EPS surprise series", () => {
    const out = buildComponentSeries(makeInputs());
    const s = out[flatKey("surprise", "latestEpsSurprise")]!;
    // floor 0.25: (1.1-1)/1, (1.2-1)/1, (0.9-1)/1
    expect(s).toEqual([
      expect.closeTo(0.1, 9),
      expect.closeTo(0.2, 9),
      expect.closeTo(-0.1, 9),
    ]);
  });

  it("passes the diluted-share series through for both dilution components", () => {
    const out = buildComponentSeries(makeInputs(10));
    const growth = out[flatKey("dilution", "shareGrowthQuality")]!;
    const cagr = out[flatKey("dilution", "shareCagr2yQuality")]!;
    // Last 8 finite of 100..109.
    expect(growth).toEqual([102, 103, 104, 105, 106, 107, 108, 109]);
    expect(cagr).toEqual(growth);
  });

  it("truncates to the last 8 finite values", () => {
    const out = buildComponentSeries(makeInputs(12));
    const s = out[flatKey("inflection", "grossMarginInflection")]!;
    expect(s).toHaveLength(8);
  });

  it("omits inherently point-in-time components (no series)", () => {
    const out = buildComponentSeries(makeInputs());
    expect(out[flatKey("residualMomentum", "residual6m1m")]).toBeUndefined();
    expect(out[flatKey("persistence", "persistenceBreadth")]).toBeUndefined();
    expect(out[flatKey("forecastConfidence", "epsDispQuality")]).toBeUndefined();
  });

  it("omits a component whose underlying series has fewer than 2 finite points", () => {
    const metric = makeMetric(10);
    // Only one finite EV/EBITDA point.
    metric.evToEbitda = Array.from({ length: 10 }, (_, i) => (i === 9 ? 10 : null));
    const out = buildComponentSeries(makeInputs(10, { metric }));
    expect(out[flatKey("valuation", "evEbitdaValue")]).toBeUndefined();
  });
});
