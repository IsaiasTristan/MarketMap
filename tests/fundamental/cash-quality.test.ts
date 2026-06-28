import { describe, expect, it } from "vitest";
import { cashQualityComponents } from "@/lib/fundamental/cash-quality";

describe("cashQualityComponents", () => {
  it("computes FCF conversion = (CFO + capex) / EBITDA when EBITDA > 0", () => {
    const c = cashQualityComponents({
      cfoTtm: 120,
      capexTtm: -20, // FMP-negative
      ebitdaTtm: 100,
      netIncomeTtm: 80,
      avgTotalAssets: 1000,
      changeInWorkingCapitalTtm: 0,
    });
    expect(c.fcfConversion!).toBeCloseTo(1.0, 9); // (120 - 20) / 100
  });
  it("nulls FCF conversion when EBITDA <= 0 (sign-flipping)", () => {
    const c = cashQualityComponents({
      cfoTtm: 50,
      capexTtm: -10,
      ebitdaTtm: -30,
      netIncomeTtm: -40,
      avgTotalAssets: 500,
      changeInWorkingCapitalTtm: 0,
    });
    expect(c.fcfConversion).toBeNull();
  });
  it("inverts accruals so high accruals score lower", () => {
    // NI >> CFO => high accruals => negative accrualQuality
    const c = cashQualityComponents({
      cfoTtm: 10,
      capexTtm: -5,
      ebitdaTtm: 100,
      netIncomeTtm: 90,
      avgTotalAssets: 1000,
      changeInWorkingCapitalTtm: 0,
    });
    expect(c.accrualQuality!).toBeLessThan(0);
  });
  it("penalises a large working-capital release inflating CFO", () => {
    const c = cashQualityComponents({
      cfoTtm: 100,
      capexTtm: -10,
      ebitdaTtm: 120,
      netIncomeTtm: 80,
      avgTotalAssets: 1000,
      changeInWorkingCapitalTtm: 70, // big positive release
    });
    expect(c.workingCapitalQuality!).toBeLessThan(0);
  });
  it("nulls working-capital quality when CFO is ~0", () => {
    const c = cashQualityComponents({
      cfoTtm: 0,
      capexTtm: -10,
      ebitdaTtm: 120,
      netIncomeTtm: 80,
      avgTotalAssets: 1000,
      changeInWorkingCapitalTtm: 70,
    });
    expect(c.workingCapitalQuality).toBeNull();
  });
});
