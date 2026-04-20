/**
 * Tests for factor risk decomposition.
 */
import { describe, it, expect } from "vitest";
import { factorCovarianceMatrix } from "../../src/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "../../src/lib/factors/risk/decomposition";
import type { FactorCode } from "../../src/types/factors";

describe("factorCovarianceMatrix", () => {
  it("returns k×k matrix", () => {
    const series = [
      [0.01, -0.005, 0.008, 0.002],
      [-0.002, 0.001, -0.003, 0.004],
    ];
    const cov = factorCovarianceMatrix(series, null, false);
    expect(cov).toHaveLength(2);
    expect(cov[0]).toHaveLength(2);
  });

  it("diagonal entries are positive variances", () => {
    const series = [
      Array.from({ length: 252 }, () => (Math.random() - 0.5) * 0.02),
      Array.from({ length: 252 }, () => (Math.random() - 0.5) * 0.01),
    ];
    const cov = factorCovarianceMatrix(series, null, false);
    expect(cov[0]![0]).toBeGreaterThan(0);
    expect(cov[1]![1]).toBeGreaterThan(0);
  });

  it("is symmetric", () => {
    const series = [
      Array.from({ length: 100 }, () => Math.random() * 0.01),
      Array.from({ length: 100 }, () => Math.random() * 0.01),
      Array.from({ length: 100 }, () => Math.random() * 0.01),
    ];
    const cov = factorCovarianceMatrix(series);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(cov[i]![j]).toBeCloseTo(cov[j]![i]!, 10);
      }
    }
  });

  it("annualization multiplies by 252", () => {
    const series = [Array.from({ length: 100 }, () => 0.01)];
    const raw = factorCovarianceMatrix(series, null, false);
    const ann = factorCovarianceMatrix(series, null, true);
    expect(ann[0]![0]).toBeCloseTo(raw[0]![0]! * 252, 6);
  });
});

describe("computeRiskDecomposition", () => {
  it("systematic + idiosyncratic ≈ total variance", () => {
    const betas = [1.1, -0.3, 0.5];
    const k = 3;
    // Diagonal covariance matrix (uncorrelated factors)
    const variances = [0.04, 0.02, 0.01]; // annualized
    const cov = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (__, j) => i === j ? variances[i]! : 0),
    );
    const idioDaily = 0.0001;

    const risk = computeRiskDecomposition(betas, cov, idioDaily, ["MKT_RF", "SMB", "HML"] as FactorCode[], 252);

    const sysVar = betas[0]! ** 2 * variances[0]! + betas[1]! ** 2 * variances[1]! + betas[2]! ** 2 * variances[2]!;
    const idioVar = idioDaily * 252;
    const totalVar = sysVar + idioVar;

    expect(risk.totalVolatility).toBeCloseTo(Math.sqrt(totalVar), 6);
    expect(risk.systematicShare + risk.idiosyncraticShare).toBeCloseTo(1.0, 6);
  });

  it("PCR factors sum to approximately systematicShare", () => {
    const betas = [1.0, 0.2];
    const cov = [[0.04, 0.0], [0.0, 0.01]];
    const idioDaily = 0.00005;

    const risk = computeRiskDecomposition(betas, cov, idioDaily, ["MKT_RF", "SMB"] as FactorCode[], 252);
    const totalPCR = risk.factors.reduce((s, f) => s + f.pctVarianceContrib, 0);
    // Sum of factor PCRs should equal systematic share
    expect(totalPCR).toBeCloseTo(risk.systematicShare, 4);
  });

  it("returns zero-filled result when betas are empty", () => {
    const risk = computeRiskDecomposition([], [], 0.0001, [], 252);
    expect(risk.totalVolatility).toBe(0);
    expect(risk.factors).toHaveLength(0);
  });
});
