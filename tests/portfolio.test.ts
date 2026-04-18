import { describe, expect, it } from "vitest";
import {
  portfolioDailyReturn,
  portfolioDailyReturnSeries,
  sumWeights,
  portfolioSharpe,
} from "@/domain/calculations/portfolio";

describe("portfolio daily return", () => {
  it("weights sum w_i * r_i", () => {
    const r = portfolioDailyReturn({
      weights: [0.5, 0.5],
      dailyReturns: [0.1, 0.02],
    });
    expect(r).toBeCloseTo(0.06, 8);
  });
});

describe("sumWeights", () => {
  it("adds to one when valid", () => {
    expect(sumWeights([0.25, 0.25, 0.5])).toBeCloseTo(1, 8);
  });
});

describe("series", () => {
  it("two names two days", () => {
    const s = portfolioDailyReturnSeries(
      [0.6, 0.4],
      [
        [0.1, 0.05],
        [0, 0.02],
      ]
    );
    expect(s[0]!).toBeCloseTo(0.08, 6);
    expect(s[1]!).toBeCloseTo(0.008, 6);
  });
});

describe("sharpe", () => {
  it("produces a number for varied path", () => {
    const d = [0.01, -0.002, 0, 0.003, 0.001, -0.0005, 0.01];
    const s = portfolioSharpe(d, 0.01);
    expect(s).not.toBeNull();
  });
});
