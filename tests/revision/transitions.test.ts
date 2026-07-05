import { describe, expect, it } from "vitest";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  detectEarningsTransitions,
  detectGroupTransitions,
  detectStockTransitions,
  nextSide,
  type GroupWeekMetrics,
  type StockWeekMetrics,
} from "@/lib/revision/transitions";

function stock(over: Partial<StockWeekMetrics>): StockWeekMetrics {
  return {
    ticker: "TST",
    primaryDecile: 5,
    gapScore: 0,
    compositeZ: 0,
    streak: { len: 0, sign: 0 },
    priorSide: null,
    priorStreak: null,
    daysToEarnings: null,
    peerGroupType: "SUBSECTOR",
    peerGroupKey: "Semis",
    ...over,
  };
}

describe("nextSide", () => {
  it("enters LONG only with top decile AND gap at/above the threshold", () => {
    expect(nextSide(null, 10, 1.5)).toBe("LONG");
    expect(nextSide(null, 10, 1.49)).toBeNull(); // gap just below
    expect(nextSide(null, 9, 3.0)).toBeNull(); // decile not extreme
  });
  it("enters SHORT only with bottom decile AND gap at/below minus threshold", () => {
    expect(nextSide(null, 1, -1.5)).toBe("SHORT");
    expect(nextSide(null, 1, -1.49)).toBeNull();
    expect(nextSide(null, 2, -3.0)).toBeNull();
  });
  it("holds a flag until |gap| falls inside the close band (hysteresis)", () => {
    expect(nextSide("LONG", 5, 0.8)).toBe("LONG"); // between 0.5 and 1.5: hold
    expect(nextSide("LONG", 5, 0.49)).toBeNull(); // gap closed
    expect(nextSide("SHORT", 5, -0.4)).toBeNull();
  });
  it("keeps the flag when gap is null (missing prices) rather than silently exiting", () => {
    expect(nextSide("LONG", 5, null)).toBe("LONG");
  });
  it("does not enter on null inputs", () => {
    expect(nextSide(null, null, 2)).toBeNull();
    expect(nextSide(null, 10, null)).toBeNull();
  });
});

describe("detectStockTransitions", () => {
  it("fires NEW_LONG on entry and not again while flagged", () => {
    const enter = detectStockTransitions([stock({ primaryDecile: 10, gapScore: 2, priorSide: null })]);
    expect(enter.map((d) => d.type)).toEqual(["NEW_LONG"]);
    const held = detectStockTransitions([stock({ primaryDecile: 10, gapScore: 2, priorSide: "LONG" })]);
    expect(held).toEqual([]);
  });
  it("fires NEW_SHORT on the mirror entry", () => {
    const out = detectStockTransitions([stock({ primaryDecile: 1, gapScore: -2 })]);
    expect(out.map((d) => d.type)).toEqual(["NEW_SHORT"]);
  });
  it("fires GAP_CLOSED when a flagged name's gap collapses", () => {
    const out = detectStockTransitions([stock({ priorSide: "LONG", gapScore: 0.2, primaryDecile: 8 })]);
    expect(out.map((d) => d.type)).toEqual(["GAP_CLOSED"]);
    expect(out[0]!.payload.priorSide).toBe("LONG");
  });
  it("fires STREAK_BROKEN only after a long-enough run flips sign", () => {
    const broken = detectStockTransitions([
      stock({ priorStreak: { len: 4, sign: 1 }, streak: { len: 1, sign: -1 } }),
    ]);
    expect(broken.map((d) => d.type)).toEqual(["STREAK_BROKEN"]);
    const tooShort = detectStockTransitions([
      stock({ priorStreak: { len: 3, sign: 1 }, streak: { len: 1, sign: -1 } }),
    ]);
    expect(tooShort).toEqual([]);
    const noFlip = detectStockTransitions([
      stock({ priorStreak: { len: 6, sign: 1 }, streak: { len: 7, sign: 1 } }),
    ]);
    expect(noFlip).toEqual([]);
    const zeroWeek = detectStockTransitions([
      stock({ priorStreak: { len: 6, sign: 1 }, streak: { len: 0, sign: 0 } }),
    ]);
    expect(zeroWeek).toEqual([]); // a null/zero week is not a flip
  });
});

describe("detectGroupTransitions", () => {
  const groups = (over: Partial<GroupWeekMetrics>): GroupWeekMetrics[] => [
    { groupType: "SUBSECTOR", groupKey: "Semis", meanZ: 0, priorMeanZ: 0, ...over },
  ];
  it("fires GROUP_INFLECTION on an upward crossing of +1.0 only", () => {
    expect(detectGroupTransitions(groups({ meanZ: 1.1, priorMeanZ: 0.8 }), []).map((d) => d.type)).toEqual([
      "GROUP_INFLECTION",
    ]);
    // Already above: no refire.
    expect(detectGroupTransitions(groups({ meanZ: 1.3, priorMeanZ: 1.1 }), [])).toEqual([]);
    // No prior week: no crossing.
    expect(detectGroupTransitions(groups({ meanZ: 1.3, priorMeanZ: null }), [])).toEqual([]);
  });
  it("fires GROUP_ROLLOVER on a downward crossing of -1.0", () => {
    expect(detectGroupTransitions(groups({ meanZ: -1.2, priorMeanZ: -0.5 }), []).map((d) => d.type)).toEqual([
      "GROUP_ROLLOVER",
    ]);
  });
  it("fires NEXT_DOMINO for laggards inside a hot group", () => {
    const g = groups({ meanZ: 1.2, priorMeanZ: 1.1 }); // hot but no crossing
    const laggard = stock({ ticker: "LAG", compositeZ: 0.2 });
    const leader = stock({ ticker: "LED", compositeZ: 2.0 });
    const otherGroup = stock({ ticker: "OTH", compositeZ: 0.0, peerGroupKey: "Software" });
    const out = detectGroupTransitions(g, [laggard, leader, otherGroup]);
    expect(out.map((d) => d.ticker)).toEqual(["LAG"]);
    expect(out[0]!.payload.direction).toBe("LONG");
    // Band edge: |z| must be <= 0.3.
    const edge = detectGroupTransitions(g, [stock({ compositeZ: 0.31 })]);
    expect(edge).toEqual([]);
  });
});

describe("detectEarningsTransitions", () => {
  it("fires inside the window with a live signal; day 7 inclusive", () => {
    const out = detectEarningsTransitions([
      { ticker: "A", compositeZ: 1.2, daysToEarnings: 7 },
      { ticker: "B", compositeZ: -1.5, daysToEarnings: 0 },
      { ticker: "C", compositeZ: 1.2, daysToEarnings: 8 }, // outside window
      { ticker: "D", compositeZ: 0.9, daysToEarnings: 3 }, // signal too weak
      { ticker: "E", compositeZ: null, daysToEarnings: 3 },
      { ticker: "F", compositeZ: 1.2, daysToEarnings: null },
    ]);
    expect(out.map((d) => d.ticker)).toEqual(["A", "B"]);
  });
});

describe("threshold wiring", () => {
  it("detectors honor injected thresholds (no magic numbers)", () => {
    const loose = { ...REVISION_THRESHOLDS, newFlagMinAbsGap: 0.5 };
    expect(nextSide(null, 10, 0.6, loose)).toBe("LONG");
    expect(nextSide(null, 10, 0.6)).toBeNull();
  });
});
