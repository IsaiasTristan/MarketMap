import { describe, it, expect } from "vitest";
import {
  zoneCensus,
  regimeVector,
  movingIntoCrowding,
  eliteLeavingCrowded,
  watchlistCensus,
  type VectorConfig,
  type ExitClusterLite,
} from "@/components/analysis/flows/quadrant/takeaways";
import type { PlottedPoint } from "@/components/analysis/flows/quadrant/quadrantModel";

const CFG: VectorConfig = { topN: 5, minTrailQuarters: 2, breadthWeight: 0.6, convictionWeight: 0.4, neutralEps: 0.02 };
const P75B = 10;
const P75C = 2;

function mk(
  ticker: string,
  over: {
    breadth?: number;
    conviction?: number | null;
    deltaHolders?: number;
    holderStreak?: number;
    prev?: { breadth: number; conviction: number | null } | null;
  } = {},
): PlottedPoint {
  return {
    ticker,
    companyName: ticker,
    sector: null,
    marketCapTier: null,
    breadth: over.breadth ?? 5,
    conviction: "conviction" in over ? over.conviction ?? null : 1,
    deltaHolders: over.deltaHolders ?? 0,
    holderStreak: over.holderStreak ?? 0,
    fundsHolding: 5,
    fundsBought: 0,
    fundsSold: 0,
    quadrant: null,
    trajectoryLabel: null,
    prev: over.prev ?? null,
    layer: "foreground",
    r: 4,
    fill: "#888",
    score: 0,
    danger: false,
  };
}

describe("zoneCensus", () => {
  const fg = [
    mk("EMERG", { breadth: 5, conviction: 4 }), // emerging
    mk("CROWD1", { breadth: 20, conviction: 4, deltaHolders: -2 }), // crowded
    mk("CROWD2", { breadth: 15, conviction: 3, deltaHolders: 5 }), // crowded
    mk("TOE", { breadth: 5, conviction: 1 }), // toe-dipping
    mk("BROAD", { breadth: 20, conviction: 1 }), // below-median
  ];

  it("counts reconcile exactly to the foreground per zone", () => {
    const census = zoneCensus(fg, P75B, P75C);
    const by = new Map(census.map((c) => [c.zone, c]));
    expect(by.get("emerging")!.count).toBe(1);
    expect(by.get("crowded")!.count).toBe(2);
    expect(by.get("toe-dipping")!.count).toBe(1);
    expect(by.get("below-median")!.count).toBe(1);
    // total reconciles to the foreground size
    expect(census.reduce((s, c) => s + c.count, 0)).toBe(fg.length);
    expect(by.get("crowded")!.netFlow).toBe(3); // -2 + 5
  });

  it("qoqDelta reflects movement into a zone", () => {
    // A name that was emerging last quarter and is crowded now: crowded +1, emerging -1.
    const moved = [mk("MOVER", { breadth: 20, conviction: 4, prev: { breadth: 5, conviction: 4 } })];
    const by = new Map(zoneCensus(moved, P75B, P75C).map((c) => [c.zone, c]));
    expect(by.get("crowded")!.qoqDelta).toBe(1);
    expect(by.get("emerging")!.qoqDelta).toBe(-1);
  });
});

describe("regimeVector", () => {
  it("reads 'crowding' when the foreground drifts up-and-right", () => {
    const fg = [
      mk("A", { breadth: 12, conviction: 3, prev: { breadth: 6, conviction: 1.5 } }),
      mk("B", { breadth: 20, conviction: 4, prev: { breadth: 10, conviction: 2 } }),
    ];
    expect(regimeVector(fg, CFG).direction).toBe("crowding");
  });

  it("sign flips to 'de-crowding' on the mirrored fixture", () => {
    const fg = [
      mk("A", { breadth: 6, conviction: 1.5, prev: { breadth: 12, conviction: 3 } }),
      mk("B", { breadth: 10, conviction: 2, prev: { breadth: 20, conviction: 4 } }),
    ];
    const v = regimeVector(fg, CFG);
    expect(v.direction).toBe("de-crowding");
    expect(v.dx).toBeLessThan(0);
  });

  it("is neutral with no trails", () => {
    expect(regimeVector([mk("A")], CFG).direction).toBe("neutral");
  });
});

describe("movingIntoCrowding", () => {
  it("ranks sustained up-and-right movers, applies the streak floor and topN", () => {
    const fg = [
      mk("FAST", { breadth: 20, conviction: 4, holderStreak: 3, prev: { breadth: 8, conviction: 2 } }),
      mk("SLOW", { breadth: 9, conviction: 2.1, holderStreak: 2, prev: { breadth: 8, conviction: 2 } }),
      mk("NOSTREAK", { breadth: 20, conviction: 4, holderStreak: 1, prev: { breadth: 8, conviction: 2 } }), // below floor
      mk("LEAVING", { breadth: 6, conviction: 1, holderStreak: 3, prev: { breadth: 12, conviction: 3 } }), // moving away
    ];
    const rows = movingIntoCrowding(fg, { ...CFG, topN: 2 });
    expect(rows.map((r) => r.ticker)).toEqual(["FAST", "SLOW"]);
    expect(rows[0]!.value).toBeGreaterThan(rows[1]!.value);
  });
});

describe("eliteLeavingCrowded", () => {
  const fg = [
    mk("CROWD", { breadth: 20, conviction: 4 }),
    mk("CROWD2", { breadth: 15, conviction: 3 }),
    mk("EMERG", { breadth: 5, conviction: 4 }),
  ];
  const exits: ExitClusterLite[] = [
    { ticker: "CROWD", eliteExits: 3, eliteSizing: 2.0, convictionExits: 5 },
    { ticker: "CROWD2", eliteExits: 1, eliteSizing: 1.0, convictionExits: 2 },
    { ticker: "EMERG", eliteExits: 4, eliteSizing: 3.0, convictionExits: 6 }, // not crowded → excluded
    { ticker: "CROWDNOELITE", eliteExits: 0, eliteSizing: 0, convictionExits: 3 },
  ];

  it("ranks only crowded-zone names with elite exits", () => {
    const rows = eliteLeavingCrowded(fg, exits, P75B, P75C, 5);
    expect(rows.map((r) => r.ticker)).toEqual(["CROWD", "CROWD2"]);
    expect(rows[0]!.value).toBeGreaterThan(rows[1]!.value);
  });
});

describe("watchlistCensus", () => {
  it("counts watchlist names in the crowded zone and QoQ movement", () => {
    const fg = [
      mk("W1", { breadth: 20, conviction: 4, prev: { breadth: 5, conviction: 4 } }), // moved into crowded
      mk("W2", { breadth: 20, conviction: 4, prev: { breadth: 20, conviction: 4 } }), // stayed crowded
      mk("NOTW", { breadth: 20, conviction: 4 }),
    ];
    const c = watchlistCensus(fg, new Set(["W1", "W2"]), P75B, P75C);
    expect(c.crowdedNow).toBe(2);
    expect(c.crowdedQoqDelta).toBe(1); // 2 now − 1 prev (only W2 was crowded last q)
  });
});
