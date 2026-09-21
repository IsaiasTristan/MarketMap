import { describe, expect, it } from "vitest";
import { buildHedgeBasket, cholesky, nnls } from "@/lib/pairs/hedge/nnls";
import type { Matrix } from "@/lib/factors/regression/matrix";
import { matMul, transpose } from "@/lib/factors/regression/matrix";

describe("cholesky", () => {
  it("reconstructs Σ = L Lᵀ for a PD matrix", () => {
    const sigma: Matrix = [
      [4, 2, 0],
      [2, 5, 1],
      [0, 1, 3],
    ];
    const L = cholesky(sigma);
    const recon = matMul(L, transpose(L));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(recon[i]![j]!).toBeCloseTo(sigma[i]![j]!, 10);
  });
});

describe("nnls", () => {
  it("matches OLS when the unconstrained solution is already non-negative", () => {
    const A: Matrix = [
      [2, 0],
      [0, 2],
    ];
    const x = nnls(A, [4, 6]);
    expect(x[0]!).toBeCloseTo(2, 8);
    expect(x[1]!).toBeCloseTo(3, 8);
  });

  it("clamps a negative unconstrained coefficient to zero", () => {
    // Unconstrained OLS would give x = [1, -1]; NNLS must return [1, 0].
    const A: Matrix = [
      [1, 0],
      [0, 1],
    ];
    const x = nnls(A, [1, -1]);
    expect(x[0]!).toBeCloseTo(1, 8);
    expect(x[1]!).toBeCloseTo(0, 8);
  });

  it("never returns a negative weight", () => {
    const A: Matrix = [
      [1, 1],
      [1, 1.0001],
    ];
    const x = nnls(A, [-2, -2]);
    expect(x.every((v) => v >= 0)).toBe(true);
  });
});

describe("buildHedgeBasket", () => {
  const cov: Matrix = [
    [0.04, 0],
    [0, 0.09],
  ];

  it("selects the candidate that removes the most factor risk", () => {
    // Long exposed to factor 0. One candidate matches it, one is orthogonal.
    const res = buildHedgeBasket({
      betaLong: [1, 0],
      candidates: [
        { key: "MATCH", beta: [1, 0], sigmaIdio2: 0 },
        { key: "ORTHO", beta: [0, 1], sigmaIdio2: 0 },
      ],
      cov,
      sigmaLongIdio2: 0,
      maxNames: 1,
      nameCap: 1,
    });
    expect(res.legs[0]!.key).toBe("MATCH");
    expect(res.legs[0]!.weight).toBeCloseTo(1, 6);
    expect(res.factorRiskRemovedPct).toBeCloseTo(1, 6);
  });

  it("respects the per-name cap", () => {
    const res = buildHedgeBasket({
      betaLong: [2, 0],
      candidates: [
        { key: "A", beta: [1, 0], sigmaIdio2: 0.01 },
        { key: "B", beta: [1, 0], sigmaIdio2: 0.01 },
      ],
      cov,
      sigmaLongIdio2: 0.02,
      maxNames: 2,
      nameCap: 0.6,
    });
    const gross = res.legs.reduce((s, l) => s + l.weight, 0);
    for (const leg of res.legs) expect(leg.weight).toBeLessThanOrEqual(0.6 * gross + 1e-9);
  });
});
