import { describe, it, expect } from "vitest";
import {
  parametricVaR,
  historicalVaR,
  expectedShortfall,
  portfolioParametricVaR,
  stressedVaR,
  Z_95,
} from "@/domain/calculations/var";

describe("parametricVaR", () => {
  it("returns positive dollar amount", () => {
    const var95 = parametricVaR(0.1, 100_000, 0.2, Z_95);
    expect(var95).toBeGreaterThan(0);
  });
  it("scales with portfolio value", () => {
    const v1 = parametricVaR(0.1, 100_000, 0.2);
    const v2 = parametricVaR(0.1, 200_000, 0.2);
    expect(v2).toBeCloseTo(v1 * 2);
  });
});

describe("historicalVaR", () => {
  const returns = [-0.05, -0.03, -0.01, 0.02, 0.04, -0.08, 0.01, -0.02, 0.03, -0.04];
  it("returns a value in the correct tail", () => {
    const var95 = historicalVaR(returns, 0.05);
    expect(var95).toBeLessThan(0);
  });
});

describe("expectedShortfall", () => {
  const returns = [-0.10, -0.08, -0.05, -0.03, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06];
  it("CVaR <= VaR (both negative)", () => {
    const cvar = expectedShortfall(returns, 0.05);
    const var95 = historicalVaR(returns, 0.05);
    expect(cvar).toBeLessThanOrEqual(var95);
  });
});

describe("portfolioParametricVaR", () => {
  it("with ρ=1 equals stressedVaR", () => {
    const weights = [0.5, 0.5];
    const vols = [0.2, 0.3];
    const identity = [[1, 1], [1, 1]];
    const stressed = stressedVaR(weights, vols, 100_000, Z_95);
    const portfolio = portfolioParametricVaR(weights, identity, vols, 100_000, Z_95);
    expect(portfolio).toBeCloseTo(stressed, 0);
  });
});
