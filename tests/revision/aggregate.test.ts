import { describe, expect, it } from "vitest";
import {
  MIN_PEERS,
  meanOrNull,
  resolvePeerGroups,
  rollupGroups,
  type RefClassification,
} from "@/lib/revision/aggregate";

describe("resolvePeerGroups", () => {
  it("uses subsector when it has >= MIN_PEERS, else falls back to sector", () => {
    const refs: RefClassification[] = [];
    // Thick subsector (MIN_PEERS names).
    for (let i = 0; i < MIN_PEERS; i++) {
      refs.push({ ticker: `THICK${i}`, sector: "Tech", subsector: "Semis" });
    }
    // Thin subsector (2 names).
    refs.push({ ticker: "THINA", sector: "Tech", subsector: "Niche" });
    refs.push({ ticker: "THINB", sector: "Tech", subsector: "Niche" });

    const peers = resolvePeerGroups(refs);
    expect(peers.get("THICK0")).toEqual({ peerGroupType: "SUBSECTOR", peerGroupKey: "Semis" });
    expect(peers.get("THINA")).toEqual({ peerGroupType: "SECTOR", peerGroupKey: "Tech" });
  });

  it("buckets unclassified names into a sector-level Unclassified group", () => {
    const peers = resolvePeerGroups([{ ticker: "X", sector: null, subsector: null }]);
    expect(peers.get("X")).toEqual({ peerGroupType: "SECTOR", peerGroupKey: "Unclassified" });
  });
});

describe("meanOrNull", () => {
  it("averages finite values, ignoring nulls", () => {
    expect(meanOrNull([1, null, 3])).toBeCloseTo(2, 12);
    expect(meanOrNull([null, null])).toBeNull();
  });
});

describe("rollupGroups", () => {
  it("aggregates breadth + composite per group, sorted by composite desc", () => {
    const items = [
      { g: "A", breadth: 0.5, comp: 1 },
      { g: "A", breadth: -0.5, comp: 3 },
      { g: "B", breadth: 0.2, comp: -1 },
    ];
    const out = rollupGroups(items, (i) => i.g, (i) => i.breadth, (i) => i.comp);
    expect(out[0]!.groupKey).toBe("A");
    expect(out[0]!.nameCount).toBe(2);
    expect(out[0]!.breadth).toBeCloseTo(0, 12);
    expect(out[0]!.compositeMean).toBeCloseTo(2, 12);
    expect(out[1]!.groupKey).toBe("B");
  });
});
