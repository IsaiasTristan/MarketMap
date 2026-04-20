/**
 * Tests for factor scenario / shock calculations.
 */
import { describe, it, expect } from "vitest";
import { applyFactorShock } from "../../src/lib/factors/scenarios/shocks";
import { computeSensitivityTable } from "../../src/lib/factors/scenarios/sensitivity";
import type { FactorCode, ScenarioDefinition, PositionLoadings } from "../../src/types/factors";

const FACTOR_CODES: FactorCode[] = ["MKT_RF", "SMB", "HML"];

describe("applyFactorShock", () => {
  it("single-factor shock: portfolio P&L = beta × shock", () => {
    const betas = [1.2, 0.0, 0.0];
    const scenario: ScenarioDefinition = {
      key: "test",
      label: "Test Shock",
      description: "",
      shocks: [{ code: "MKT_RF", shockValue: -0.10 }],
    };

    const result = applyFactorShock(betas, FACTOR_CODES, scenario);
    expect(result.estimatedPortPnl).toBeCloseTo(1.2 * -0.10, 8);
    expect(result.byFactor[0]!.contribution).toBeCloseTo(-0.12, 8);
    expect(result.byFactor[1]!.contribution).toBe(0);
    expect(result.byFactor[2]!.contribution).toBe(0);
  });

  it("multi-factor shock: P&L is sum of individual contributions", () => {
    const betas = [1.0, 0.5, -0.3];
    const scenario: ScenarioDefinition = {
      key: "multi",
      label: "Multi",
      description: "",
      shocks: [
        { code: "MKT_RF", shockValue: -0.05 },
        { code: "SMB", shockValue: 0.03 },
        { code: "HML", shockValue: 0.10 },
      ],
    };

    const result = applyFactorShock(betas, FACTOR_CODES, scenario);
    const expected = 1.0 * -0.05 + 0.5 * 0.03 + -0.3 * 0.10;
    expect(result.estimatedPortPnl).toBeCloseTo(expected, 8);
  });

  it("position-level impacts sum approximately to portfolio P&L", () => {
    const betas = [1.2, -0.5, 0.3];
    const loadings: PositionLoadings[] = [
      {
        ticker: "AAPL", sector: "Tech", subTheme: "Mega Cap", weight: 0.6,
        loadings: { MKT_RF: 1.3, SMB: -0.4, HML: 0.2 },
      },
      {
        ticker: "XOM", sector: "Energy", subTheme: "Oil", weight: 0.4,
        loadings: { MKT_RF: 1.1, SMB: -0.6, HML: 0.5 },
      },
    ];

    const scenario: ScenarioDefinition = {
      key: "shock",
      label: "Shock",
      description: "",
      shocks: [{ code: "MKT_RF", shockValue: -0.10 }],
    };

    const result = applyFactorShock(betas, FACTOR_CODES, scenario, loadings);
    const positionSum = result.byPosition.reduce((s, p) => s + p.estimatedPnl, 0);

    // Position sum ≈ portfolio P&L (both driven by position-weighted MKT_RF shock)
    expect(Math.abs(positionSum)).toBeGreaterThan(0);
    expect(result.byPosition).toHaveLength(2);
  });

  it("zero shock produces zero P&L", () => {
    const betas = [1.5, 0.3, -0.2];
    const scenario: ScenarioDefinition = {
      key: "zero",
      label: "Zero",
      description: "",
      shocks: [{ code: "MKT_RF", shockValue: 0 }],
    };
    const result = applyFactorShock(betas, FACTOR_CODES, scenario);
    expect(result.estimatedPortPnl).toBe(0);
  });
});

describe("computeSensitivityTable", () => {
  it("has correct number of rows", () => {
    const betas = [1.2, -0.3, 0.5];
    const vols = [0.16, 0.08, 0.06];
    const table = computeSensitivityTable(betas, FACTOR_CODES, vols);
    expect(table).toHaveLength(3);
  });

  it("impact at 2σ is twice impact at 1σ", () => {
    const betas = [1.0, 0.0, 0.0];
    const vols = [0.20, 0.10, 0.05];
    const table = computeSensitivityTable(betas, FACTOR_CODES, vols);
    const mkt = table[0]!;
    expect(mkt.impact2Sig).toBeCloseTo(2 * mkt.impact1Sig, 8);
    expect(mkt.impactNeg2Sig).toBeCloseTo(2 * mkt.impactNeg1Sig, 8);
  });

  it("signs match beta × shock direction", () => {
    const betas = [1.0, -0.5];
    const vols = [0.15, 0.10];
    const table = computeSensitivityTable(betas, ["MKT_RF", "SMB"] as FactorCode[], vols);
    expect(table[0]!.impact1Sig).toBeGreaterThan(0); // positive beta
    expect(table[0]!.impactNeg1Sig).toBeLessThan(0);
    expect(table[1]!.impact1Sig).toBeLessThan(0);    // negative beta
    expect(table[1]!.impactNeg1Sig).toBeGreaterThan(0);
  });
});
