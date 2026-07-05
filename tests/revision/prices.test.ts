import { describe, expect, it } from "vitest";
import { trailingReturns, weeklyCloseSeries, weeklyGridDates } from "@/lib/revision/prices";

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
    expect(s[0]).toEqual({ snapshotDate: "2026-06-27", close: 102, priceDate: "2026-06-26" });
    expect(s[1]).toEqual({ snapshotDate: "2026-07-05", close: 105, priceDate: "2026-07-02" });
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
