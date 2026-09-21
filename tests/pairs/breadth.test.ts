import { describe, expect, it } from "vitest";
import {
  breadthGap,
  capWeightedBreadth,
  crowdBreadthPct,
  e1Direction,
  groupBreadth,
  upDownPct,
  type BreadthMember,
} from "@/lib/pairs/breadth";

const m = (ticker: string, direction: -1 | 0 | 1, marketCap?: number | null): BreadthMember => ({
  ticker,
  direction,
  marketCap,
});

describe("groupBreadth", () => {
  it("computes 100 * (up - down) / n in pp", () => {
    const r = groupBreadth([m("A", 1), m("B", 1), m("C", -1), m("D", 0)]);
    expect(r.breadth).toBeCloseTo((100 * (2 - 1)) / 4, 10);
    expect(r).toMatchObject({ n: 4, improving: 2, deteriorating: 1, flat: 1 });
  });
  it("is null on an empty group", () => {
    expect(groupBreadth([]).breadth).toBeNull();
  });
  it("is +100 when everyone raises, -100 when everyone cuts", () => {
    expect(groupBreadth([m("A", 1), m("B", 1)]).breadth).toBe(100);
    expect(groupBreadth([m("A", -1), m("B", -1)]).breadth).toBe(-100);
  });
});

describe("capWeightedBreadth", () => {
  it("weights votes by market cap and drops names with no cap", () => {
    // 90-cap up, 10-cap down => 100*(0.9 - 0.1) = +80.
    const r = capWeightedBreadth([m("A", 1, 90), m("B", -1, 10), m("C", 1, null)]);
    expect(r.breadth).toBeCloseTo(80, 6);
    expect(r.n).toBe(2);
  });
  it("differs from equal-weight when caps are skewed (the ew-cw spread)", () => {
    const members = [m("Mega", 1, 1000), m("Small1", -1, 10), m("Small2", -1, 10)];
    const ew = groupBreadth(members).breadth!;
    const cw = capWeightedBreadth(members).breadth!;
    expect(ew).toBeLessThan(0); // 1 up, 2 down => -33pp
    expect(cw).toBeGreaterThan(0); // mega-cap up dominates
  });
});

describe("breadthGap", () => {
  it("subtracts short breadth from long breadth", () => {
    expect(breadthGap(70, 40)).toBe(30);
  });
  it("is null when either side is null", () => {
    expect(breadthGap(null, 40)).toBeNull();
    expect(breadthGap(70, null)).toBeNull();
  });
});

describe("e1Direction", () => {
  it("is the sign of ptUp - ptDown", () => {
    expect(e1Direction(3, 1)).toBe(1);
    expect(e1Direction(1, 3)).toBe(-1);
    expect(e1Direction(2, 2)).toBe(0);
  });
});

describe("upDownPct", () => {
  it("reports raise/cut share for the matrix hover", () => {
    const r = upDownPct([m("A", 1), m("B", 1), m("C", -1), m("D", 0)]);
    expect(r.upPct).toBe(50);
    expect(r.downPct).toBe(25);
  });
});

describe("crowdBreadthPct", () => {
  it("counts the share of names above the crowding floor, not the basket mean", () => {
    // Two names above 4.17 out of five -> 40% breadth, even though the mean is low.
    expect(crowdBreadthPct([0.5, 1.0, 5.0, 6.0, 0.2], 4.17)).toBeCloseTo(40, 9);
  });
  it("drops non-finite / missing values and returns null when nothing is known", () => {
    expect(crowdBreadthPct([null, undefined, NaN], 4.17)).toBeNull();
    expect(crowdBreadthPct([], 4.17)).toBeNull();
    // 10 above out of 10 finite (nulls ignored) -> 100%.
    expect(crowdBreadthPct([10, 10, null], 4.17)).toBeCloseTo(100, 9);
  });
});
