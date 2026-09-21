import { describe, expect, it } from "vitest";
import { e2Direction } from "@/lib/pairs/e2-breadth";
import type { InflectionSignals } from "@/lib/fundamental/inflection";

const sig = (v: Partial<InflectionSignals>): InflectionSignals => ({
  grossMarginInflection: null,
  ebitdaMarginInflection: null,
  revenueGrowthAccel: null,
  fcfInflection: null,
  roicTrend: null,
  deleveraging: null,
  ...v,
});

describe("e2Direction", () => {
  it("votes on the sign of the raw components (scale-free)", () => {
    // Wildly different magnitudes: 4 positive, 1 negative => up.
    const r = e2Direction(
      sig({
        grossMarginInflection: 0.0001,
        ebitdaMarginInflection: 500,
        revenueGrowthAccel: 3,
        fcfInflection: 0.02,
        roicTrend: -0.00001,
      }),
    );
    expect(r?.direction).toBe(1);
    expect(r?.positive).toBe(4);
    expect(r?.negative).toBe(1);
  });
  it("is deteriorating when more components are negative", () => {
    const r = e2Direction(sig({ grossMarginInflection: -1, fcfInflection: -1, roicTrend: 1 }));
    expect(r?.direction).toBe(-1);
  });
  it("is flat on a tie", () => {
    const r = e2Direction(sig({ grossMarginInflection: 1, fcfInflection: -1, roicTrend: 2, deleveraging: -2 }));
    expect(r?.direction).toBe(0);
  });
  it("is unclassifiable (null) below the minimum available components", () => {
    expect(e2Direction(sig({ grossMarginInflection: 1 }), 3)).toBeNull();
  });
});
