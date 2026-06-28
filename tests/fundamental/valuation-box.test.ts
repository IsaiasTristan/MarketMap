import { describe, expect, it } from "vitest";
import { valuationBoxComponents } from "@/lib/fundamental/valuation-box";

describe("valuationBoxComponents", () => {
  it("inverts positive EV/EBITDA and P/E (cheaper = higher score)", () => {
    const c = valuationBoxComponents({
      evToEbitda: 8,
      peRatio: 15,
      fcfYield: 0.05,
      dividendYield: 0.02,
    });
    expect(c.evEbitdaValue!).toBeCloseTo(-8, 9);
    expect(c.peValue!).toBeCloseTo(-15, 9);
    expect(c.fcfYieldValue!).toBeCloseTo(0.05, 9);
    expect(c.divYieldValue!).toBeCloseTo(0.02, 9);
  });
  it("drops negative EV/EBITDA and P/E (no cheapness meaning)", () => {
    const c = valuationBoxComponents({
      evToEbitda: -5,
      peRatio: -12,
      fcfYield: -0.03,
      dividendYield: 0,
    });
    expect(c.evEbitdaValue).toBeNull();
    expect(c.peValue).toBeNull();
    // FCF yield may legitimately be negative and is kept
    expect(c.fcfYieldValue!).toBeCloseTo(-0.03, 9);
    expect(c.divYieldValue!).toBeCloseTo(0, 9);
  });
});
