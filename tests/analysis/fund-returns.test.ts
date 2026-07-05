import { describe, expect, it } from "vitest";
import {
  quarterReturn,
  returnConfidence,
  isLowCoverage,
  fundQualityWeight,
  type BookReturnPosition,
} from "@/domain/calculations/fund-returns";
import {
  chainReturns,
  trailingWindow,
  windowExcess,
  cloneAlpha,
  priceAsOfOnOrBefore,
  WINDOW_QUARTERS,
  type QuarterReturn,
} from "@/domain/calculations/return-series";
import { FUND_OVERVIEW_CONFIG as CFG } from "@/domain/calculations/fund-overview-config";

const pos = (ticker: string, reportedWeight: number, positionReturn: number | null): BookReturnPosition => ({
  ticker,
  reportedWeight,
  positionReturn,
});

describe("quarterReturn", () => {
  it("value-weights a 2-position book; contributions sum to the total", () => {
    // 60% at +10%, 40% at −5% → 0.6·0.10 + 0.4·(−0.05) = 0.04
    const r = quarterReturn([pos("AAA", 0.6, 0.1), pos("BBB", 0.4, -0.05)]);
    expect(r.ret).toBeCloseTo(0.04, 6);
    expect(r.coveragePct).toBeCloseTo(100, 6);
    expect(r.excludedWeightBps).toBe(0);
    expect(r.positionsCovered).toBe(2);
    // Σ contribBps == book return in bps.
    const sumBps = r.contributions.reduce((a, c) => a + c.contribBps, 0);
    expect(sumBps).toBeCloseTo((r.ret as number) * 10_000, 0);
  });

  it("renormalizes over covered names and discloses excluded weight when a position has no price", () => {
    // 50% AAA +10%, 30% BBB −5%, 20% CCC delisted (no return).
    const r = quarterReturn([pos("AAA", 0.5, 0.1), pos("BBB", 0.3, -0.05), pos("CCC", 0.2, null)]);
    // covered weight = 0.8 → coverage 80%, excluded 2000 bps.
    expect(r.coveragePct).toBeCloseTo(80, 6);
    expect(r.excludedWeightBps).toBe(2000);
    expect(r.positionsCovered).toBe(2);
    // renormalized: (0.5·0.10 + 0.3·(−0.05)) / 0.8 = 0.035/0.8 = 0.04375 (round4 → 0.0438)
    expect(r.ret).toBeCloseTo(0.0438, 6);
    expect(isLowCoverage(r.coveragePct)).toBe(true); // 80 < 85
  });

  it("returns null with nothing covered", () => {
    const r = quarterReturn([pos("AAA", 0.5, null), pos("BBB", 0.5, null)]);
    expect(r.ret).toBeNull();
    expect(r.coveragePct).toBeCloseTo(0, 6);
    expect(r.contributions).toEqual([]);
  });
});

describe("returnConfidence", () => {
  it("bands on trailing-4q turnover (%/q)", () => {
    expect(returnConfidence(18)).toBe("HIGH"); // < 25
    expect(returnConfidence(25)).toBe("MED"); // [25,45]
    expect(returnConfidence(45)).toBe("MED");
    expect(returnConfidence(46)).toBe("LOW"); // > 45
  });
});

describe("fundQualityWeight", () => {
  it("is neutral 1.0 at zero alpha and when alpha is unknown (new funds never penalized)", () => {
    expect(fundQualityWeight(0)).toBe(1);
    expect(fundQualityWeight(null)).toBe(1);
  });
  it("saturates to the configured bounds and stays clamped", () => {
    expect(fundQualityWeight(CFG.fund_quality_weight.alpha_at_max)).toBeCloseTo(CFG.fund_quality_weight.max, 6);
    expect(fundQualityWeight(-CFG.fund_quality_weight.alpha_at_max)).toBeCloseTo(CFG.fund_quality_weight.min, 6);
    expect(fundQualityWeight(10)).toBe(CFG.fund_quality_weight.max); // clamped
    expect(fundQualityWeight(-10)).toBe(CFG.fund_quality_weight.min);
  });
  it("is monotone in alpha", () => {
    expect(fundQualityWeight(0.01)).toBeGreaterThan(fundQualityWeight(0));
    expect(fundQualityWeight(-0.01)).toBeLessThan(fundQualityWeight(0));
  });
});

describe("chainReturns / trailingWindow", () => {
  const series = (rets: Array<number | null>): QuarterReturn[] =>
    rets.map((r, i) => ({ period: `2025-0${i + 1}-01`, ret: r }));

  it("compounds quarters", () => {
    expect(chainReturns([0.1, 0.1])).toBeCloseTo(0.21, 6);
  });

  it("1Y window is cumulative, not annualized", () => {
    const w = trailingWindow(series([0.05, 0.05, 0.05, 0.05]), WINDOW_QUARTERS["1Y"]!);
    expect(w.insufficient).toBe(false);
    expect(w.annualized).toBe(false);
    expect(w.ret).toBeCloseTo(Math.pow(1.05, 4) - 1, 4);
  });

  it("2Y window is annualized geometrically", () => {
    const eight = new Array(8).fill(0.05);
    const w = trailingWindow(series(eight), WINDOW_QUARTERS["2Y"]!);
    expect(w.annualized).toBe(true);
    // 8 quarters of 5% → cumulative (1.05^8−1); annualized back to 4q/yr.
    const cumulative = Math.pow(1.05, 8) - 1;
    expect(w.ret).toBeCloseTo(Math.pow(1 + cumulative, 4 / 8) - 1, 4);
  });

  it("history shorter than the window ⇒ insufficient (never padded)", () => {
    const w = trailingWindow(series([0.05, 0.05]), WINDOW_QUARTERS["1Y"]!);
    expect(w.insufficient).toBe(true);
    expect(w.ret).toBeNull();
  });

  it("a null (gap/coverage hole) inside the window ⇒ insufficient, not compounded across the hole", () => {
    const w = trailingWindow(series([0.05, null, 0.05, 0.05]), WINDOW_QUARTERS["1Y"]!);
    expect(w.insufficient).toBe(true);
    expect(w.ret).toBeNull();
  });
});

describe("windowExcess", () => {
  it("subtracts benchmark; null-safe", () => {
    expect(windowExcess(0.18, 0.07)).toBeCloseTo(0.11, 6);
    expect(windowExcess(null, 0.07)).toBeNull();
    expect(windowExcess(0.18, null)).toBeNull();
  });
});

describe("cloneAlpha", () => {
  it("annualized excess over quarters where both are usable", () => {
    // 4 quarters, clone +5%/q, bench +2%/q.
    const clone = [0.05, 0.05, 0.05, 0.05];
    const bench = [0.02, 0.02, 0.02, 0.02];
    const r = cloneAlpha(clone, bench);
    expect(r.quarters).toBe(4);
    const annClone = Math.pow(Math.pow(1.05, 4), 4 / 4) - 1;
    const annBench = Math.pow(Math.pow(1.02, 4), 4 / 4) - 1;
    expect(r.alpha).toBeCloseTo(annClone - annBench, 4);
  });
  it("skips quarters where either side is null", () => {
    const r = cloneAlpha([0.05, null, 0.05], [0.02, 0.02, null]);
    expect(r.quarters).toBe(1); // only index 0 has both
  });
  it("no overlapping data ⇒ null alpha", () => {
    expect(cloneAlpha([null, null], [0.02, 0.02]).alpha).toBeNull();
  });
});

describe("priceAsOfOnOrBefore", () => {
  const s = [
    { t: 10, px: 1 },
    { t: 20, px: 2 },
    { t: 30, px: 3 },
  ];
  it("returns the last close on/before the date", () => {
    expect(priceAsOfOnOrBefore(s, 25)).toBe(2);
    expect(priceAsOfOnOrBefore(s, 30)).toBe(3);
    expect(priceAsOfOnOrBefore(s, 30_000)).toBe(3);
  });
  it("returns null before the first point (no lookahead into the future)", () => {
    expect(priceAsOfOnOrBefore(s, 5)).toBeNull();
  });
});
