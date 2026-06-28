import { describe, expect, it } from "vitest";
import { persistenceBreadth, persistenceComponents } from "@/lib/fundamental/persistence";

describe("persistenceBreadth", () => {
  it("is 1 when every metric improves every transition", () => {
    const rising = [1, 2, 3, 4];
    const b = persistenceBreadth([
      { series: rising },
      { series: rising },
    ]);
    expect(b!).toBeCloseTo(1, 9); // 6 observations all improving
  });
  it("treats a falling net-leverage series as improving (lowerIsBetter)", () => {
    const falling = [4, 3, 2, 1];
    const b = persistenceBreadth([
      { series: falling, lowerIsBetter: true },
      { series: falling, lowerIsBetter: true },
    ]);
    expect(b!).toBeCloseTo(1, 9);
  });
  it("is 0 when nothing improves", () => {
    const falling = [4, 3, 2, 1];
    const b = persistenceBreadth([{ series: falling }, { series: falling }]);
    expect(b!).toBeCloseTo(0, 9);
  });
  it("returns null below the minimum observation count", () => {
    expect(persistenceBreadth([{ series: [1, 2] }])).toBeNull(); // 1 obs < 6
  });
});

describe("persistenceComponents", () => {
  it("scores breadth across the six core fundamentals", () => {
    const up = [0.1, 0.2, 0.3, 0.4];
    const down = [4, 3, 2, 1];
    const c = persistenceComponents({
      revenueGrowthYoy: up,
      grossMargin: up,
      ebitdaMargin: up,
      fcfMargin: up,
      roic: up,
      netDebtToEbitda: down,
    });
    expect(c.persistenceBreadth!).toBeCloseTo(1, 9);
  });
});
