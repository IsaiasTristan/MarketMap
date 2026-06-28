import { describe, expect, it } from "vitest";
import {
  pearson,
  boxCorrelationReport,
  MIN_CORRELATION_OVERLAP,
} from "@/lib/fundamental/box-correlation";
import type { BoxScoreRecord } from "@/lib/fundamental/box-correlation";

describe("pearson", () => {
  it("returns +1 for a perfectly increasing relationship", () => {
    const n = MIN_CORRELATION_OVERLAP;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = xs.map((x) => 2 * x + 3);
    const r = pearson(xs, ys);
    expect(r).not.toBeNull();
    expect(r!.rho).toBeCloseTo(1, 6);
    expect(r!.n).toBe(n);
  });

  it("returns -1 for a perfectly decreasing relationship", () => {
    const n = MIN_CORRELATION_OVERLAP;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = xs.map((x) => -x);
    expect(pearson(xs, ys)!.rho).toBeCloseTo(-1, 6);
  });

  it("ignores non-finite pairs and requires the minimum overlap", () => {
    const xs = [1, 2, null, 4, NaN];
    const ys = [1, 2, 3, 4, 5];
    expect(pearson(xs, ys, 2)).not.toBeNull();
    expect(pearson(xs, ys, 4)).toBeNull(); // only 3 finite pairs
  });

  it("returns null on zero variance", () => {
    const n = MIN_CORRELATION_OVERLAP;
    const xs = Array.from({ length: n }, () => 5);
    const ys = Array.from({ length: n }, (_, i) => i);
    expect(pearson(xs, ys)).toBeNull();
  });
});

describe("boxCorrelationReport", () => {
  it("flags a highly-correlated box pair and leaves the diagonal at 1", () => {
    const n = MIN_CORRELATION_OVERLAP;
    const rows: BoxScoreRecord[] = Array.from({ length: n }, (_, i) => ({
      boxScores: {
        inflection: i,
        surprise: i + 0.01 * Math.sin(i), // near-perfectly correlated with inflection
        valuation: (i % 2 === 0 ? 1 : -1) * i, // decorrelated
      },
    }));
    const report = boxCorrelationReport(rows, 0.8);
    const infIdx = report.keys.indexOf("inflection");
    expect(report.matrix[infIdx]![infIdx]).toBe(1);
    const pair = report.flagged.find(
      (p) =>
        (p.a === "inflection" && p.b === "surprise") ||
        (p.a === "surprise" && p.b === "inflection"),
    );
    expect(pair).toBeDefined();
    expect(Math.abs(pair!.rho)).toBeGreaterThan(0.8);
  });

  it("reports no flags when boxes are uncorrelated / sparse", () => {
    const rows: BoxScoreRecord[] = Array.from({ length: 5 }, () => ({
      boxScores: { inflection: 1, surprise: 2 },
    }));
    // Below MIN_CORRELATION_OVERLAP -> every pair is null, nothing flagged.
    expect(boxCorrelationReport(rows).flagged).toHaveLength(0);
  });
});
