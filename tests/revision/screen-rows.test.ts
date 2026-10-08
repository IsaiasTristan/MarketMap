import { describe, expect, it } from "vitest";
import {
  consecutiveAtDecile,
  decileChurn,
  likeForLikeChange,
  subsectorBreadth,
  subsectorMeans,
  zHistogram,
  HISTOGRAM_BINS,
} from "@/lib/revision/screen-rows";
import { ptMoveCounts, reconstructPtPanels, weeklyActionCounts } from "@/lib/revision/legb-history";

describe("consecutiveAtDecile", () => {
  it("counts the run ending on the current week", () => {
    expect(consecutiveAtDecile([5, 10, 3, 10, 10, 10], 10)).toBe(3);
  });

  it("is zero when this week is not at the target", () => {
    expect(consecutiveAtDecile([10, 10, 10, 9], 10)).toBe(0);
  });

  it("counts the short side the same way", () => {
    expect(consecutiveAtDecile([4, 1, 1], 1)).toBe(2);
  });
});

describe("zHistogram", () => {
  it("clamps tails into the end bins so outliers are still visible", () => {
    const h = zHistogram([-9, 9, 0]);
    expect(h).toHaveLength(HISTOGRAM_BINS);
    expect(h[0]).toBe(1);
    expect(h[HISTOGRAM_BINS - 1]).toBe(1);
    expect(h.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("skips nulls and non-finite values", () => {
    expect(zHistogram([null, Number.NaN, 1]).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("puts zero in the centre bin", () => {
    const h = zHistogram([0]);
    expect(h[(HISTOGRAM_BINS - 1) / 2]).toBe(1);
  });
});

describe("subsectorMeans / subsectorBreadth", () => {
  const mk = (subsector: string, n: number, value: number) =>
    Array.from({ length: n }, () => ({ subsector, value }));

  it("drops subsectors below the minimum name count", () => {
    const means = subsectorMeans([...mk("Refining", 8, 1), ...mk("Tiny", 3, 5)]);
    expect([...means.keys()]).toEqual(["Refining"]);
    expect(means.get("Refining")!.n).toBe(8);
  });

  it("z-scores ACROSS subsectors and sorts strongest first", () => {
    const means = subsectorMeans([
      ...mk("Hot", 10, 2),
      ...mk("Mid", 10, 0),
      ...mk("Cold", 10, -2),
    ]);
    const cells = subsectorBreadth(means, null);
    expect(cells.map((c) => c.name)).toEqual(["Hot", "Mid", "Cold"]);
    expect(cells[0]!.z).toBeGreaterThan(0);
    expect(cells[2]!.z).toBeLessThan(0);
    expect(cells[1]!.z).toBeCloseTo(0, 12);
    expect(cells.every((c) => c.chg4w === null)).toBe(true);
  });

  it("reports the 4-week change in the cross-subsector z", () => {
    const prior = subsectorMeans([...mk("Hot", 10, -2), ...mk("Cold", 10, 2)]);
    const cur = subsectorMeans([...mk("Hot", 10, 2), ...mk("Cold", 10, -2)]);
    const cells = subsectorBreadth(cur, prior);
    const hot = cells.find((c) => c.name === "Hot")!;
    expect(hot.chg4w).toBeGreaterThan(0);
  });
});

describe("decileChurn", () => {
  it("splits entries and exits deterministically", () => {
    const churn = decileChurn(new Set(["B", "A"]), new Set(["B", "C"]));
    expect(churn.arrivals).toEqual(["C"]);
    expect(churn.exits).toEqual(["A"]);
  });
});

describe("likeForLikeChange", () => {
  const prior = new Map<string, number | null>([
    ["2026-12-31", 2],
    ["2027-12-31", 4],
  ]);

  it("compares the SAME fiscal period so a year roll is not a revision", () => {
    // Forward period rolled from FY26 to FY27; the FY27 base is what counts.
    expect(likeForLikeChange(5, "2027-12-31", prior)).toBeCloseTo(0.25, 12);
  });

  it("returns null when the prior snapshot has no matching period", () => {
    expect(likeForLikeChange(5, "2028-12-31", prior)).toBeNull();
  });

  it("returns null on a non-positive base rather than a meaningless ratio", () => {
    expect(likeForLikeChange(1, "LOSS", new Map([["LOSS", -0.5]]))).toBeNull();
  });

  it("returns null without a prior snapshot at all", () => {
    expect(likeForLikeChange(5, "2027-12-31", null)).toBeNull();
  });
});

describe("ptMoveCounts", () => {
  const grid = ["2026-01-05", "2026-01-12"];

  it("counts raises and cuts on the matched panel only", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-01-02", analyst: "A", priceTarget: 100 },
        { dateIso: "2026-01-02", analyst: "B", priceTarget: 50 },
        { dateIso: "2026-01-10", analyst: "A", priceTarget: 120 },
        { dateIso: "2026-01-10", analyst: "B", priceTarget: 40 },
      ],
      grid,
    );
    expect(ptMoveCounts(panels)[1]).toEqual({ up: 1, down: 1 });
  });

  it("does not count an initiation as a raise", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-01-02", analyst: "A", priceTarget: 100 },
        { dateIso: "2026-01-10", analyst: "NEW", priceTarget: 200 },
      ],
      grid,
    );
    expect(ptMoveCounts(panels)[1]).toEqual({ up: 0, down: 0 });
  });

  it("never exceeds the panel size (the ptUp + ptDown <= analystCount invariant)", () => {
    const panels = reconstructPtPanels(
      [
        { dateIso: "2026-01-02", analyst: "A", priceTarget: 10 },
        { dateIso: "2026-01-10", analyst: "A", priceTarget: 11 },
        { dateIso: "2026-01-10", analyst: "B", priceTarget: 12 },
      ],
      grid,
    );
    const m = ptMoveCounts(panels)[1]!;
    expect(m.up + m.down).toBeLessThanOrEqual(panels[1]!.size);
  });
});

describe("weeklyActionCounts", () => {
  it("buckets upgrades, downgrades and initiations into their grid week", () => {
    const counts = weeklyActionCounts(
      [
        { dateIso: "2026-01-06", action: "upgrade" },
        { dateIso: "2026-01-07", action: "downgrade" },
        { dateIso: "2026-01-08", action: "initialise coverage" },
        { dateIso: "2026-01-08", action: "maintain" },
      ],
      ["2026-01-05", "2026-01-12"],
    );
    expect(counts[0]).toEqual({ up: 0, down: 0, init: 0 });
    expect(counts[1]).toEqual({ up: 1, down: 1, init: 1 });
  });
});
