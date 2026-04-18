import { describe, expect, it } from "vitest";
import {
  alignCloseSeries,
  intersectAlignedCloses,
  dailyReturnVectorsFromMatrix,
} from "@/domain/calculations/alignment";

describe("alignCloseSeries", () => {
  it("inner joins dates", () => {
    const a = [
      { date: "2024-01-02", adjClose: 10 },
      { date: "2024-01-03", adjClose: 11 },
    ];
    const b = [
      { date: "2024-01-02", adjClose: 100 },
      { date: "2024-01-03", adjClose: 102 },
    ];
    const r = alignCloseSeries(a, b);
    expect(r.dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(r.stock).toEqual([10, 11]);
    expect(r.bench).toEqual([100, 102]);
  });
});

describe("intersectAlignedCloses", () => {
  it("aligns two series", () => {
    const s1 = [
      { date: "2024-01-01", adjClose: 1 },
      { date: "2024-01-02", adjClose: 2 },
    ];
    const s2 = [
      { date: "2024-01-02", adjClose: 10 },
      { date: "2024-01-03", adjClose: 11 },
    ];
    const { dates, matrix } = intersectAlignedCloses([s1, s2]);
    expect(dates).toEqual(["2024-01-02"]);
    expect(matrix).toEqual([[2], [10]]);
  });
});

describe("dailyReturnVectorsFromMatrix", () => {
  it("computes per-asset daily returns", () => {
    const m = [
      [10, 11],
      [100, 90],
    ];
    const d = dailyReturnVectorsFromMatrix(m);
    expect(d.length).toBe(1);
    expect(d[0]![0]).toBeCloseTo(0.1, 6);
    expect(d[0]![1]).toBeCloseTo(-0.1, 6);
  });
});
