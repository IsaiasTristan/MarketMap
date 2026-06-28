import { describe, expect, it } from "vitest";
import {
  actionScore,
  forwardReturnAt,
  informationCoefficient,
  pearson,
  quantileSpread,
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
