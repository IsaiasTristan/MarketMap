import { describe, expect, it } from "vitest";
import {
  actionScore,
  averageRanks,
  decileForwardStats,
  forwardReturnAt,
  icSummary,
  informationCoefficient,
  meanDrift,
  pearson,
  quantileSpread,
  rollingIC,
  spearman,
} from "@/lib/revision/backtest";

describe("pearson", () => {
  it("is +1 for a perfect positive line", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
  });
  it("is -1 for a perfect negative line", () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });
  it("is null for degenerate inputs", () => {
    expect(pearson([1, 1, 1], [1, 1, 1])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
  });
});

describe("actionScore", () => {
  it("maps grade actions to direction", () => {
    expect(actionScore("upgrade")).toBe(1);
    expect(actionScore("downgrade")).toBe(-1);
    expect(actionScore("maintain")).toBe(0);
    expect(actionScore(null)).toBe(0);
  });
});

describe("forwardReturnAt", () => {
  it("computes simple forward return over the horizon", () => {
    const closes = [100, 101, 102, 110];
    expect(forwardReturnAt(closes, 0, 3)).toBeCloseTo(0.1, 12);
  });
  it("returns null when the horizon runs off the end", () => {
    expect(forwardReturnAt([100, 101], 0, 5)).toBeNull();
  });
});

describe("informationCoefficient + quantileSpread", () => {
  it("recovers a positive IC and spread when signal predicts return", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      signal: i,
      forwardReturn: i * 0.001,
    }));
    expect(informationCoefficient(pairs)!).toBeGreaterThan(0.9);
    const qs = quantileSpread(pairs);
    expect(qs.spread!).toBeGreaterThan(0);
    expect(qs.topMean!).toBeGreaterThan(qs.bottomMean!);
  });
});

describe("averageRanks + spearman", () => {
  it("tie-averages ranks", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });
  it("is 1 for any monotone (even nonlinear) relation, unlike pearson", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => Math.exp(x)); // convex monotone
    expect(spearman(xs, ys)!).toBeCloseTo(1, 12);
    expect(pearson(xs, ys)!).toBeLessThan(1);
  });
  it("handles ties and is null for degenerate inputs", () => {
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])!).toBeCloseTo(1, 12);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [2, 1])).toBeNull();
  });
});

describe("decileForwardStats", () => {
  it("orders buckets by signal strength and computes D10-D1 + hit rate", () => {
    const pairs = Array.from({ length: 100 }, (_, i) => ({
      signal: i,
      forwardReturn: i >= 90 ? 0.05 : i < 10 ? -0.05 : 0,
    }));
    const s = decileForwardStats(pairs);
    expect(s.buckets).toHaveLength(10);
    expect(s.buckets[9]!.meanFwd!).toBeCloseTo(0.05, 12);
    expect(s.buckets[0]!.meanFwd!).toBeCloseTo(-0.05, 12);
    expect(s.d10d1!).toBeCloseTo(0.1, 12);
    expect(s.d10HitRate!).toBeCloseTo(1, 12);
  });
  it("leaves empty buckets null on tiny cross-sections", () => {
    const s = decileForwardStats([
      { signal: 1, forwardReturn: 0.1 },
      { signal: 2, forwardReturn: 0.2 },
    ]);
    expect(s.n).toBe(2);
    expect(s.buckets.filter((b) => b.meanFwd !== null).length).toBe(2);
  });
});

describe("rollingIC", () => {
  const week = (date: string, slope: 1 | -1) => ({
    date,
    pairs: Array.from({ length: 12 }, (_, i) => ({ signal: i, forwardReturn: slope * i * 0.01 })),
  });
  it("clamps the window to available weeks (1- and 2-week datasets still produce points)", () => {
    const out = rollingIC([week("2026-06-27", 1), week("2026-07-04", 1)], 4);
    expect(out).toHaveLength(2);
    expect(out[0]!.weeksUsed).toBe(1);
    expect(out[1]!.weeksUsed).toBe(2);
    expect(out[1]!.ic!).toBeCloseTo(1, 6);
  });
  it("means weekly ICs over the trailing window", () => {
    const out = rollingIC([week("w1", 1), week("w2", -1)], 2);
    expect(out[1]!.ic!).toBeCloseTo(0, 6);
  });
  it("skips weeks whose IC is null (thin cross-section)", () => {
    const thin = { date: "w1", pairs: [{ signal: 1, forwardReturn: 0.1 }] };
    const out = rollingIC([thin, week("w2", 1)], 4);
    expect(out[0]!.ic).toBeNull();
    expect(out[0]!.weeksUsed).toBe(0);
    expect(out[1]!.weeksUsed).toBe(1);
  });
});

describe("meanDrift", () => {
  it("means per horizon across events, ignoring unfilled horizons", () => {
    const drift = meanDrift([
      [0.01, 0.02, null],
      [0.03, null, null],
    ]);
    expect(drift[0]!).toBeCloseTo(0.02, 12);
    expect(drift[1]!).toBeCloseTo(0.02, 12);
    expect(drift[2]).toBeNull();
  });
  it("is empty with no events", () => {
    expect(meanDrift([])).toEqual([]);
  });
});

describe("icSummary", () => {
  it("computes mean and t-stat over finite ICs", () => {
    const s = icSummary([0.1, 0.2, 0.3, null]);
    expect(s.n).toBe(3);
    expect(s.mean!).toBeCloseTo(0.2, 12);
    expect(s.tStat!).toBeGreaterThan(0);
  });
  it("degrades on sparse input", () => {
    expect(icSummary([0.1])).toEqual({ mean: 0.1, tStat: null, n: 1 });
    expect(icSummary([null, null])).toEqual({ mean: null, tStat: null, n: 0 });
  });
});
