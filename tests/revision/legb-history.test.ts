import { describe, expect, it } from "vitest";
import {
  ptRevisionFromConsensus,
  reconstructPtConsensus,
  weeklyNetActions,
} from "@/lib/revision/legb-history";

describe("weeklyNetActions", () => {
  const grid = ["2026-06-20", "2026-06-27", "2026-07-04"];
  it("sums action scores over (prevGridDate, gridDate] windows", () => {
    const events = [
      { dateIso: "2026-06-21", action: "upgrade" },
      { dateIso: "2026-06-25", action: "upgrade" },
      { dateIso: "2026-06-27", action: "downgrade" }, // ON the grid date -> that week
      { dateIso: "2026-06-28", action: "downgrade" }, // day after -> next week
    ];
    const out = weeklyNetActions(events, grid);
    expect(out[0]).toEqual({ net: 0, count: 0 });
    expect(out[1]).toEqual({ net: 1, count: 3 }); // +1 +1 -1
    expect(out[2]).toEqual({ net: -1, count: 1 });
  });
  it("excludes events before the first window (one nominal step back)", () => {
    const out = weeklyNetActions([{ dateIso: "2026-06-01", action: "upgrade" }], grid);
    expect(out.map((w) => w.count)).toEqual([0, 0, 0]);
  });
  it("scores maintains as zero but counts them as activity", () => {
    const out = weeklyNetActions([{ dateIso: "2026-06-26", action: "maintain" }], grid);
    expect(out[1]).toEqual({ net: 0, count: 1 });
  });
  it("handles empty grid / no events", () => {
    expect(weeklyNetActions([], grid).map((w) => w.net)).toEqual([0, 0, 0]);
    expect(weeklyNetActions([{ dateIso: "2026-06-26", action: "upgrade" }], [])).toEqual([]);
  });
});

describe("reconstructPtConsensus", () => {
  const grid = ["2026-06-20", "2026-06-27", "2026-07-04"];
  it("uses each analyst's latest target on or before the date", () => {
    const events = [
      { dateIso: "2026-06-15", analyst: "FirmA", priceTarget: 100 },
      { dateIso: "2026-06-16", analyst: "FirmB", priceTarget: 200 },
      { dateIso: "2026-06-25", analyst: "FirmA", priceTarget: 120 }, // supersedes A's 100
    ];
    const out = reconstructPtConsensus(events, grid);
    expect(out[0]!).toBeCloseTo(150, 12); // (100 + 200) / 2
    expect(out[1]!).toBeCloseTo(160, 12); // (120 + 200) / 2
    expect(out[2]!).toBeCloseTo(160, 12);
  });
  it("evicts targets older than the staleness window", () => {
    const events = [{ dateIso: "2026-01-01", analyst: "FirmA", priceTarget: 100 }];
    const out = reconstructPtConsensus(events, ["2026-07-04"], 90);
    expect(out[0]).toBeNull();
  });
  it("keeps null-analyst events as individual voices", () => {
    const events = [
      { dateIso: "2026-06-25", analyst: null, priceTarget: 100 },
      { dateIso: "2026-06-26", analyst: null, priceTarget: 200 },
    ];
    const out = reconstructPtConsensus(events, ["2026-06-27"]);
    expect(out[0]!).toBeCloseTo(150, 12);
  });
  it("ignores non-positive targets and returns null with no events", () => {
    expect(reconstructPtConsensus([{ dateIso: "2026-06-25", analyst: "A", priceTarget: 0 }], ["2026-06-27"])[0]).toBeNull();
    expect(reconstructPtConsensus([], ["2026-06-27"])[0]).toBeNull();
  });
});

describe("ptRevisionFromConsensus", () => {
  it("chains week-over-week relative changes", () => {
    const out = ptRevisionFromConsensus([100, 110, 110]);
    expect(out[0]).toBeNull();
    expect(out[1]!).toBeCloseTo(0.1, 12);
    expect(out[2]!).toBeCloseTo(0, 12);
  });
  it("propagates nulls at gaps", () => {
    const out = ptRevisionFromConsensus([null, 100, null, 120]);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull(); // no prior
    expect(out[2]).toBeNull(); // no current
    expect(out[3]).toBeNull(); // prior missing
  });
});
