import { describe, expect, it } from "vitest";
import {
  ptConsensusFromPanels,
  ptPanelStats,
  ptRevisionFromConsensus,
  ptRevisionMatched,
  reconstructPtConsensus,
  reconstructPtPanels,
  weeklyNetActions,
} from "@/lib/revision/legb-history";

describe("reconstructPtPanels + ptRevisionMatched (matched-panel signal)", () => {
  const grid = ["2026-06-06", "2026-06-13", "2026-06-20", "2026-06-27"];
  it("supersedes on the analyst key (expertUID), so two analysts at one firm are two voices", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-06-01", analyst: "uid-a", priceTarget: 100 },
        { dateIso: "2026-06-02", analyst: "uid-b", priceTarget: 200 }, // same firm in reality, different analyst
        { dateIso: "2026-06-10", analyst: "uid-a", priceTarget: 120 },
      ],
      grid,
    );
    expect(panels[0]!.size).toBe(2);
    expect(panels[1]!.get("uid-a")!.pt).toBe(120);
    expect(ptConsensusFromPanels(panels)[1]!).toBeCloseTo(160, 12);
  });
  it("a new initiation moves the LEVEL but contributes ZERO matched revision", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-06-01", analyst: "a", priceTarget: 100 },
        { dateIso: "2026-06-10", analyst: "b", priceTarget: 300 }, // enters week 2 — no prior
      ],
      grid,
    );
    const level = ptConsensusFromPanels(panels);
    expect(level[0]).toBe(100);
    expect(level[1]).toBe(200); // level jumps 100%
    const rev = ptRevisionMatched(panels);
    expect(rev[1]).toEqual({ revision: 0, matched: 1 }); // only `a` is in both weeks, unchanged
  });
  it("a source going dark (panel shrinks) generates zero signal — the cancellation seam", () => {
    // Analysts a,b,c from TipRanks up to 2026-06-13; c's target then goes stale at a 10-day window.
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-06-05", analyst: "a", priceTarget: 100, source: "TIPRANKS" },
        { dateIso: "2026-06-05", analyst: "b", priceTarget: 200, source: "TIPRANKS" },
        { dateIso: "2026-06-05", analyst: "c", priceTarget: 300, source: "TIPRANKS" },
        { dateIso: "2026-06-19", analyst: "a", priceTarget: 100, source: "FMP" }, // a refreshes via FMP, unchanged
        { dateIso: "2026-06-19", analyst: "b", priceTarget: 200, source: "FMP" },
      ],
      grid,
      10,
    );
    expect(ptPanelStats(panels).map((s) => s.size)).toEqual([3, 3, 2, 2]);
    const level = ptConsensusFromPanels(panels);
    expect(level[1]).toBe(200);
    expect(level[2]).toBe(150); // level drops 25% purely from c's eviction
    const rev = ptRevisionMatched(panels);
    expect(rev[2]).toEqual({ revision: 0, matched: 2 }); // signal: exactly zero
    expect(ptPanelStats(panels)[2]!.sourceMix).toBe(0); // and the mix diagnostic shows the source switch
    expect(ptPanelStats(panels)[1]!.sourceMix).toBe(1);
  });
  it("captures a genuine target change from a matched analyst", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-06-01", analyst: "a", priceTarget: 100 },
        { dateIso: "2026-06-01", analyst: "b", priceTarget: 100 },
        { dateIso: "2026-06-10", analyst: "a", priceTarget: 120 },
      ],
      grid,
    );
    const rev = ptRevisionMatched(panels);
    expect(rev[1]!.matched).toBe(2);
    expect(rev[1]!.revision!).toBeCloseTo(0.1, 12); // (0.2 + 0) / 2
    expect(rev[2]).toEqual({ revision: 0, matched: 2 });
  });
  it("returns null revision when nothing matches (first week, empty panels)", () => {
    const panels = reconstructPtPanels([{ dateIso: "2026-06-10", analyst: "a", priceTarget: 100 }], grid);
    const rev = ptRevisionMatched(panels);
    expect(rev[0]).toEqual({ revision: null, matched: 0 });
    expect(rev[1]).toEqual({ revision: null, matched: 0 }); // a has no prior
    expect(rev[2]).toEqual({ revision: 0, matched: 1 });
    expect(ptPanelStats(panels)[0]).toEqual({ size: 0, sourceMix: null });
  });
});

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
