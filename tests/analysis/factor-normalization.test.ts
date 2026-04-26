import { describe, expect, it } from "vitest";
import { normalizeFactorRows } from "../../src/lib/factors/regression/normalization";
import { multivariateOls } from "../../src/lib/factors/regression/ols";
import type { FactorCode } from "../../src/types/factors";

function mkRows(values: number[]): number[][] {
  return values.map((v) => [v]);
}

describe("rolling factor normalization", () => {
  it("uses trailing stats ending at t-1 (no look-ahead)", () => {
    const values = Array.from({ length: 80 }, (_, i) => 0.001 + (i % 7) * 0.0005);
    values[70] = 0.08; // large print
    const result = normalizeFactorRows(
      mkRows(values),
      [{ code: "EQ" as FactorCode, inputType: "RETURN" }],
      { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: null },
    );
    const hist = values.slice(0, 70);
    const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
    const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / (hist.length - 1);
    const sigma = Math.sqrt(variance);
    const capped = Math.max(mean - 5 * sigma, Math.min(mean + 5 * sigma, values[70]!));
    expect(result.winsorizedRows[70]![0]).toBeCloseTo(capped, 12);
    expect(result.normalizedRows[70]![0]).toBeCloseTo(capped / sigma, 12);
  });

  it("does not normalize before minimum trailing observations", () => {
    const values = Array.from({ length: 70 }, (_, i) => 0.001 + i * 0.0001);
    const result = normalizeFactorRows(
      mkRows(values),
      [{ code: "EQ" as FactorCode, inputType: "RETURN" }],
      { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: null },
    );
    expect(result.normalizedRows[59]![0]).toBeNull();
    expect(result.normalizedRows[60]![0]).not.toBeNull();
  });

  it("flags ambiguous factors and counts normalization-gated rows", () => {
    const values = Array.from({ length: 65 }, (_, i) => 0.001 + i * 0.0001);
    const result = normalizeFactorRows(
      mkRows(values),
      [{ code: "RF" as FactorCode, inputType: "AMBIGUOUS" }],
      { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: null },
    );
    expect(result.diagnostics.ambiguousFactors).toEqual(["RF"]);
    expect(result.diagnostics.totalRowsDroppedForNormalization).toBe(65);
  });

  it("preserves coefficient/t-stat signs versus raw regression", () => {
    const n = 300;
    const x1 = Array.from({ length: n }, (_, i) => Math.sin(i / 13) * 0.01 + (i % 5) * 0.001);
    const x2 = Array.from({ length: n }, (_, i) => Math.cos(i / 17) * 0.008 - (i % 3) * 0.0008);
    const y = Array.from({ length: n }, (_, i) => 0.7 * x1[i]! - 0.4 * x2[i]! + Math.sin(i / 7) * 0.002);
    const xRaw = Array.from({ length: n }, (_, i) => [x1[i]!, x2[i]!]);
    const rawFit = multivariateOls(y, xRaw);

    const norm = normalizeFactorRows(
      xRaw,
      [
        { code: "EQ" as FactorCode, inputType: "RETURN" },
        { code: "RATES" as FactorCode, inputType: "RETURN" },
      ],
      { rollingWindow: 252, minObservations: 60, winsorSigma: 5, targetAnnualVol: 0.1 },
    );
    const xNorm: number[][] = [];
    const yNorm: number[] = [];
    for (let i = 0; i < n; i++) {
      const row = norm.normalizedRows[i];
      if (!row || row.some((v) => v == null)) continue;
      xNorm.push(row as number[]);
      yNorm.push(y[i]!);
    }
    const normFit = multivariateOls(yNorm, xNorm);
    expect(Math.sign(normFit.betas[0]!)).toBe(Math.sign(rawFit.betas[0]!));
    expect(Math.sign(normFit.betas[1]!)).toBe(Math.sign(rawFit.betas[1]!));
    expect(Math.sign(normFit.tStats[0]!)).toBe(Math.sign(rawFit.tStats[0]!));
    expect(Math.sign(normFit.tStats[1]!)).toBe(Math.sign(rawFit.tStats[1]!));
  });
});
