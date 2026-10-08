import { describe, expect, it } from "vitest";
import {
  forwardReturns,
  trailingReturns,
  weeklyCloseSeries,
  weeklyGridDates,
} from "@/lib/revision/prices";

describe("weeklyGridDates", () => {
  it("keeps actual snapshot dates verbatim and extends backward in 7-day steps", () => {
    const grid = weeklyGridDates(["2026-06-27", "2026-07-05"], 2);
    expect(grid).toEqual(["2026-06-13", "2026-06-20", "2026-06-27", "2026-07-05"]);
  });
  it("dedupes and sorts irregular actual dates", () => {
    const grid = weeklyGridDates(["2026-07-05", "2026-06-27", "2026-07-05"], 0);
    expect(grid).toEqual(["2026-06-27", "2026-07-05"]);
  });
  it("is empty with no actual dates", () => {
    expect(weeklyGridDates([], 10)).toEqual([]);
  });
});

describe("weeklyCloseSeries", () => {
  const bars = [
    { date: "2026-06-24", close: 100 },
    { date: "2026-06-26", close: 102 },
    { date: "2026-07-02", close: 105 },
  ];
  it("takes the last bar on or before each grid date", () => {
    const s = weeklyCloseSeries(bars, ["2026-06-27", "2026-07-05"]);
    expect(s[0]).toEqual({
      snapshotDate: "2026-06-27",
      close: 102,
      priceDate: "2026-06-26",
      closeNext: 105,
      closeNextDate: "2026-07-02",
    });
    expect(s[1]).toEqual({
      snapshotDate: "2026-07-05",
      close: 105,
      priceDate: "2026-07-02",
      closeNext: null,
      closeNextDate: null,
    });
  });
  it("takes the first bar STRICTLY after the grid date as the t+1 entry", () => {
    // A bar ON the grid date is the close, never the entry.
    const s = weeklyCloseSeries(
      [
        { date: "2026-06-26", close: 100 },
        { date: "2026-06-29", close: 108 },
      ],
      ["2026-06-26"],
    );
    expect(s[0]!.close).toBe(100);
    expect(s[0]!.closeNext).toBe(108);
    expect(s[0]!.closeNextDate).toBe("2026-06-29");
  });
  it("drops the entry when no bar trades within the gap limit", () => {
    const s = weeklyCloseSeries(
      [
        { date: "2026-06-26", close: 100 },
        { date: "2026-07-06", close: 108 }, // 10 days later — halt / delisting
      ],
      ["2026-06-26"],
    );
    expect(s[0]!.close).toBe(100);
    expect(s[0]!.closeNext).toBeNull();
    expect(s[0]!.closeNextDate).toBeNull();
  });
  it("still records an entry when the close itself is too stale", () => {
    // Re-listing after a long halt: no usable close, but the week is tradeable.
    const s = weeklyCloseSeries(
      [
        { date: "2026-05-01", close: 100 },
        { date: "2026-06-29", close: 108 },
      ],
      ["2026-06-27"],
      6,
    );
    expect(s[0]!.close).toBeNull();
    expect(s[0]!.closeNext).toBe(108);
  });
  it("nulls a close when the freshest bar is too stale", () => {
    const s = weeklyCloseSeries(bars, ["2026-08-01"], 6);
    expect(s[0]!.close).toBeNull();
    expect(s[0]!.priceDate).toBeNull();
  });
  it("nulls grid dates before the first bar (not yet listed)", () => {
    const s = weeklyCloseSeries(bars, ["2026-06-20", "2026-06-27"]);
    expect(s[0]!.close).toBeNull();
    expect(s[1]!.close).toBe(102);
  });
  it("ignores non-positive / non-finite closes", () => {
    const s = weeklyCloseSeries([{ date: "2026-06-26", close: 0 }], ["2026-06-27"]);
    expect(s[0]!.close).toBeNull();
  });
});

describe("trailingReturns", () => {
  it("computes 1/4/13 grid-step returns where the lookback exists", () => {
    const closes = Array.from({ length: 14 }, (_, i) => 100 * 1.01 ** i);
    const r = trailingReturns(closes);
    expect(r[13]!.ret1w!).toBeCloseTo(0.01, 10);
    expect(r[13]!.ret4w!).toBeCloseTo(1.01 ** 4 - 1, 10);
    expect(r[13]!.ret13w!).toBeCloseTo(1.01 ** 13 - 1, 10);
  });
  it("nulls returns whose lookback runs off the front (sparse history)", () => {
    const r = trailingReturns([100, 110]);
    expect(r[1]!.ret1w!).toBeCloseTo(0.1, 12);
    expect(r[1]!.ret4w).toBeNull();
    expect(r[1]!.ret13w).toBeNull();
    expect(r[0]!.ret1w).toBeNull();
  });
  it("propagates missing closes as null endpoints", () => {
    const r = trailingReturns([100, null, 120]);
    expect(r[1]!.ret1w).toBeNull(); // this week missing
    expect(r[2]!.ret1w).toBeNull(); // prior week missing
  });
});

describe("forwardReturns", () => {
  it("measures entry-to-entry over exactly `horizon` grid steps", () => {
    const entries = [100, 101, 102, 103, 104, 105];
    const f = forwardReturns(entries, 4);
    expect(f.values[0]!).toBeCloseTo(104 / 100 - 1, 12);
    expect(f.values[1]!).toBeCloseTo(105 / 101 - 1, 12);
    // The last 4 slots have no future entry yet.
    expect(f.values.slice(2)).toEqual([null, null, null, null]);
    expect(f.measured).toBe(2);
    expect(f.dropped).toBe(0);
  });
  it("counts (not fills) ticker-weeks with a missing entry at either end", () => {
    const f = forwardReturns([100, null, 102, 103, null, 105], 2);
    expect(f.values[0]!).toBeCloseTo(0.02, 12); // 100 -> 102
    expect(f.values[1]).toBeNull(); // entry missing
    expect(f.values[2]).toBeNull(); // exit missing
    expect(f.values[3]!).toBeCloseTo(105 / 103 - 1, 12);
    expect(f.measured).toBe(2);
    expect(f.dropped).toBe(2);
  });
  it("telescopes: chained 1w entry returns compound to the 4w entry return", () => {
    const entries = [100, 103, 99, 107, 111];
    const h1 = forwardReturns(entries, 1).values;
    const chained = h1.slice(0, 4).reduce<number>((acc, r) => acc * (1 + (r ?? 0)), 1) - 1;
    expect(forwardReturns(entries, 4).values[0]!).toBeCloseTo(chained, 12);
  });
  it("is all-null when the horizon exceeds the grid", () => {
    const f = forwardReturns([100, 101], 5);
    expect(f.values).toEqual([null, null]);
    expect(f.measured).toBe(0);
    expect(f.dropped).toBe(0);
  });
});
