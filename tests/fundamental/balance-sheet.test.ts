import { describe, expect, it } from "vitest";
import {
  COVERAGE_CAP,
  RUNWAY_CAP,
  balanceSheetComponents,
} from "@/lib/fundamental/balance-sheet";

describe("balanceSheetComponents", () => {
  it("inverts net leverage (lower is better)", () => {
    const c = balanceSheetComponents({
      netDebtToEbitda: 2,
      ebitdaTtm: 100,
      interestExpenseTtm: 10,
      cash: 50,
      fcfTtm: 30,
      totalDebt: 200,
    });
    expect(c.netLeverageQuality!).toBeCloseTo(-2, 9);
    expect(c.interestCoverage!).toBeCloseTo(10, 9); // 100 / 10
  });
  it("caps interest coverage for debt/interest-free names with positive EBITDA", () => {
    const c = balanceSheetComponents({
      netDebtToEbitda: -1,
      ebitdaTtm: 100,
      interestExpenseTtm: 0,
      cash: 500,
      fcfTtm: 50,
      totalDebt: 0,
    });
    expect(c.interestCoverage).toBe(COVERAGE_CAP);
    expect(c.cashRunway).toBe(RUNWAY_CAP); // debt-free => maximal runway
  });
  it("nulls coverage when there is no interest and EBITDA <= 0", () => {
    const c = balanceSheetComponents({
      netDebtToEbitda: null,
      ebitdaTtm: -20,
      interestExpenseTtm: 0,
      cash: 10,
      fcfTtm: -5,
      totalDebt: 100,
    });
    expect(c.interestCoverage).toBeNull();
    expect(c.netLeverageQuality).toBeNull();
  });
  it("ignores negative FCF in the runway cushion (uses max(FCF,0))", () => {
    const c = balanceSheetComponents({
      netDebtToEbitda: 3,
      ebitdaTtm: 50,
      interestExpenseTtm: 25,
      cash: 100,
      fcfTtm: -40,
      totalDebt: 200,
    });
    expect(c.cashRunway!).toBeCloseTo(0.5, 9); // 100 / 200, FCF clamped to 0
  });
});
