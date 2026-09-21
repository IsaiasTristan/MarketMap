import { describe, expect, it } from "vitest";
import { meanVector, shrinkBetasByGroup, shrinkToward } from "@/lib/pairs/hedge/shrink";
import { singleNameHedge } from "@/lib/pairs/hedge/single-name";
import type { Matrix } from "@/lib/factors/regression/matrix";

describe("shrink", () => {
  it("meanVector averages element-wise", () => {
    expect(meanVector([[1, 3], [3, 5]])).toEqual([2, 4]);
  });

  it("shrinkToward interpolates at λ", () => {
    expect(shrinkToward([2, 0], [0, 2], 0.5)).toEqual([1, 1]);
  });

  it("shrinks each name toward its group mean", () => {
    const out = shrinkBetasByGroup(
      [
        { key: "A", group: "g", beta: [1, 0] },
        { key: "B", group: "g", beta: [3, 0] },
      ],
      0.5,
    );
    // group mean = [2, 0]; A → 0.5*1 + 0.5*2 = 1.5
    expect(out.get("A")![0]!).toBeCloseTo(1.5, 10);
    expect(out.get("B")![0]!).toBeCloseTo(2.5, 10);
  });
});

describe("singleNameHedge", () => {
  const cov: Matrix = [
    [0.04, 0],
    [0, 0.09],
  ];

  it("removes all factor risk when candidate matches the long exactly", () => {
    const res = singleNameHedge([1, 0], [1, 0], cov, 0, 0);
    expect(res.weight).toBeCloseTo(1, 8);
    expect(res.factorRiskRemovedPct).toBeCloseTo(1, 8);
  });

  it("gives w=0 and removes nothing for an orthogonal candidate", () => {
    const res = singleNameHedge([1, 0], [0, 1], cov, 0, 0);
    expect(res.weight).toBeCloseTo(0, 8);
    expect(res.factorRiskRemovedPct).toBeCloseTo(0, 8);
  });

  it("idiosyncratic variance shrinks the optimal weight (regression to mean)", () => {
    const noIdio = singleNameHedge([1, 0], [1, 0], cov, 0, 0).weight;
    const withIdio = singleNameHedge([1, 0], [1, 0], cov, 0, 0.04).weight;
    expect(withIdio).toBeLessThan(noIdio);
    // w = (β_L′Σβ_c)/(β_c′Σβ_c + σ²_c) = 0.04 / (0.04 + 0.04) = 0.5
    expect(withIdio).toBeCloseTo(0.5, 8);
  });
});
