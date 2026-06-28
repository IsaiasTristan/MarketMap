import { describe, expect, it } from "vitest";
import { percentileOf, valuationPercentiles } from "@/lib/fundamental/valuation";

describe("percentileOf", () => {
  it("ranks a value within its history", () => {
    expect(percentileOf(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(0.5, 6);
    expect(percentileOf(1, [1, 2, 3, 4])).toBeCloseTo(0.25, 6);
  });
  it("returns null on empty history or non-finite value", () => {
    expect(percentileOf(5, [])).toBeNull();
    expect(percentileOf(null, [1, 2])).toBeNull();
  });
});

describe("valuationPercentiles", () => {
  it("cheapness is high when current multiples sit low in their own range", () => {
    const hist = { peRatio: [10, 20, 30, 40, 50], evToEbitda: [5, 10, 15, 20, 25], priceToSales: [1, 2, 3, 4, 5] };
    const cheap = valuationPercentiles({ peRatio: 10, evToEbitda: 5, priceToSales: 1 }, hist);
    const rich = valuationPercentiles({ peRatio: 50, evToEbitda: 25, priceToSales: 5 }, hist);
    expect(cheap.cheapness!).toBeGreaterThan(rich.cheapness!);
    expect(cheap.cheapness!).toBeGreaterThan(0.5);
  });
  it("ignores negative multiples (no valuation meaning)", () => {
    const v = valuationPercentiles(
      { peRatio: -12, evToEbitda: 8, priceToSales: 2 },
      { peRatio: [10, 20, 30], evToEbitda: [5, 10, 15], priceToSales: [1, 2, 3] },
    );
    expect(v.peRatio).toBeNull();
    expect(v.evToEbitda).not.toBeNull();
  });
});
