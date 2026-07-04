import { describe, it, expect } from "vitest";
import { isBelowRange, partitionGutter } from "@/components/analysis/flows/quadrant/gutter";

const FLOOR = 0.3; // 0.3% of book — matches quadrantConfig gutter.floorBps / 100

describe("isBelowRange", () => {
  it("treats null conviction as below range", () => {
    expect(isBelowRange(null, FLOOR)).toBe(true);
  });

  it("is true strictly below the floor", () => {
    expect(isBelowRange(0.1, FLOOR)).toBe(true);
    expect(isBelowRange(0.299, FLOOR)).toBe(true);
  });

  it("keeps a value exactly on the floor in range", () => {
    expect(isBelowRange(FLOOR, FLOOR)).toBe(false);
  });

  it("is false above the floor", () => {
    expect(isBelowRange(0.5, FLOOR)).toBe(false);
    expect(isBelowRange(4, FLOOR)).toBe(false);
  });
});

describe("partitionGutter", () => {
  interface Pt {
    ticker: string;
    conviction: number | null;
  }
  const pts: Pt[] = [
    { ticker: "A", conviction: 2 },
    { ticker: "B", conviction: 0.1 },
    { ticker: "C", conviction: null },
    { ticker: "D", conviction: 0.3 },
    { ticker: "E", conviction: 0.2 },
  ];

  it("partitions into disjoint, total sets", () => {
    const { inRange, belowRange } = partitionGutter(pts, FLOOR);
    expect(inRange.map((p) => p.ticker)).toEqual(["A", "D"]);
    expect(belowRange.map((p) => p.ticker)).toEqual(["B", "C", "E"]);
    // total: every input lands in exactly one side
    expect(inRange.length + belowRange.length).toBe(pts.length);
    const ids = new Set([...inRange, ...belowRange].map((p) => p.ticker));
    expect(ids.size).toBe(pts.length);
  });

  it("preserves input order within each side (deterministic)", () => {
    const a = partitionGutter(pts, FLOOR);
    const b = partitionGutter(pts, FLOOR);
    expect(a).toEqual(b);
  });

  it("handles all-in-range and all-below inputs", () => {
    expect(partitionGutter([{ conviction: 5 }], FLOOR).belowRange).toEqual([]);
    expect(partitionGutter([{ conviction: null }], FLOOR).inRange).toEqual([]);
  });
});
