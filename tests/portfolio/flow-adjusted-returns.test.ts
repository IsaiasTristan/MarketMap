import { describe, it, expect } from "vitest";
import {
  flowAdjustedDailyReturns,
  flowMatchedBenchmarkDollars,
} from "@/lib/portfolio/holdings-replay";

describe("flowAdjustedDailyReturns", () => {
  it("a pure deposit day produces a 0% return", () => {
    // Day 1: NAV rose from 100 to 150 but 50 of that was a deposit.
    const nav = [100, 150];
    const flow = [0, 50];
    const r = flowAdjustedDailyReturns(nav, flow);
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(0, 12);
  });

  it("matches a known time-weighted return across a flow", () => {
    // Day 1: 100 → 110 with no flow = +10%.
    // Day 2: start 110, deposit 10 (base 120), end 132 = +10%.
    const nav = [100, 110, 132];
    const flow = [0, 0, 10];
    const r = flowAdjustedDailyReturns(nav, flow);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(0.1, 12);
    // Compounded TWR = 1.1 * 1.1 - 1 = 21%.
    const twr = r.reduce((acc, x) => acc * (1 + x), 1) - 1;
    expect(twr).toBeCloseTo(0.21, 12);
  });

  it("emits 0 on a non-positive base (not yet funded / wiped out)", () => {
    const r = flowAdjustedDailyReturns([0, 100], [0, 0]);
    expect(r[0]).toBe(0);
  });

  it("has no return on the first day", () => {
    expect(flowAdjustedDailyReturns([100], [0])).toEqual([]);
  });
});

describe("flowMatchedBenchmarkDollars", () => {
  it("invests each flow into the index and marks accumulated units at close", () => {
    // Day 0: put in 1000 at price 100 → 10 units.
    // Day 1: price 110, no flow → 10 × 110 = 1100.
    // Day 2: price 121, add 121 → +1 unit = 11 units × 121 = 1331.
    const flow = [1000, 0, 121];
    const bench = [100, 110, 121];
    const out = flowMatchedBenchmarkDollars(flow, bench);
    expect(out[0]).toBeCloseTo(1000, 9);
    expect(out[1]).toBeCloseTo(1100, 9);
    expect(out[2]).toBeCloseTo(1331, 9);
  });

  it("carries the prior value forward when a close is missing", () => {
    const out = flowMatchedBenchmarkDollars([1000, 0], [100, null]);
    expect(out[0]).toBeCloseTo(1000, 9);
    expect(out[1]).toBeCloseTo(1000, 9);
  });

  it("a withdrawal (negative flow) reduces accumulated units", () => {
    // Day 0: 1000 at 100 = 10 units. Day 1: withdraw 550 at 110 → -5 units → 5 units × 110 = 550.
    const out = flowMatchedBenchmarkDollars([1000, -550], [100, 110]);
    expect(out[1]).toBeCloseTo(550, 9);
  });
});
