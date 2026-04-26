import { describe, it, expect } from "vitest";
import {
  computeVIF,
  conditionNumber,
  multicollinearityReport,
} from "@/lib/factors/market/multicollinearity";

describe("multicollinearity diagnostics", () => {
  it("identity correlation matrix → all VIFs = 1, κ = 1", () => {
    const k = 5;
    const I = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
    );
    const vif = computeVIF(I);
    const kappa = conditionNumber(I);
    for (const v of vif) expect(v).toBeCloseTo(1, 6);
    expect(kappa).toBeCloseTo(1, 4);
  });

  it("perfectly correlated pair → high VIF and large κ", () => {
    // 3-factor matrix where factors 0 and 1 are 95% correlated.
    const M = [
      [1.0, 0.95, 0.0],
      [0.95, 1.0, 0.0],
      [0.0, 0.0, 1.0],
    ];
    const vif = computeVIF(M);
    expect(vif[0]).toBeGreaterThan(5);
    expect(vif[1]).toBeGreaterThan(5);
    expect(vif[2]).toBeCloseTo(1, 4);
    expect(conditionNumber(M)).toBeGreaterThan(5);
  });

  it("multicollinearityReport flags high pairs and reports VIF + κ", () => {
    const M = [
      [1.0, 0.85, 0.1],
      [0.85, 1.0, 0.2],
      [0.1, 0.2, 1.0],
    ];
    const r = multicollinearityReport(M, 0.7);
    expect(r.hasHighPairwise).toBe(true);
    expect(r.highPairs.length).toBe(1);
    expect(r.highPairs[0]?.i).toBe(0);
    expect(r.highPairs[0]?.j).toBe(1);
    expect(Math.abs(r.highPairs[0]!.rho - 0.85)).toBeLessThan(1e-9);
    expect(r.vif[0]).toBeGreaterThan(2);
    expect(r.conditionNumber).toBeGreaterThan(2);
  });
});
