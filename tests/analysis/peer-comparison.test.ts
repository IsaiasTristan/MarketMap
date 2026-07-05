import { describe, expect, it } from "vitest";
import {
  zScoreColumns,
  styleMatrix,
  cosineSimilarity,
  topTwins,
  overlapScore,
  percentileInSet,
  differentiatedIdeas,
  type WeightedHolding,
  type StyleComponents,
} from "@/domain/calculations/peer-comparison";
import { FUND_OVERVIEW_CONFIG as CFG } from "@/domain/calculations/fund-overview-config";

const h = (ticker: string, weight: number): WeightedHolding => ({ ticker, weight });

describe("zScoreColumns", () => {
  it("z-scores each column and zeroes a degenerate (constant) column", () => {
    const z = zScoreColumns([
      [1, 5],
      [2, 5],
      [3, 5],
    ]);
    // column 0: mean 2, population std √(2/3); column 1 constant → 0.
    expect(z[0]![1]).toBe(0);
    expect(z[1]![1]).toBe(0);
    expect(z[0]![0]).toBeLessThan(0);
    expect(z[2]![0]).toBeGreaterThan(0);
    expect(z[0]![0] + z[1]![0] + z[2]![0]).toBeCloseTo(0, 9); // z-scores sum to 0
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for parallel, 0 for orthogonal, and 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("topTwins", () => {
  const sc = (sectorMix: number[], top10: number, turnover: number, tenure: number): StyleComponents => ({
    sectorMix,
    sizeBandMix: [0.5, 0.5],
    top10,
    turnover,
    medianTenure: tenure,
  });

  it("excludes self, returns k, and is deterministic", () => {
    const funds = new Map<string, StyleComponents>([
      ["A", sc([0.8, 0.2], 0.6, 18, 4)],
      ["B", sc([0.78, 0.22], 0.61, 19, 4)], // near-twin of A
      ["C", sc([0.1, 0.9], 0.3, 45, 1)], // opposite
      ["D", sc([0.75, 0.25], 0.58, 20, 5)],
    ]);
    const ids = [...funds.keys()];
    const mat = styleMatrix([...funds.values()], CFG.style_vector);
    const vectors = new Map(ids.map((id, i) => [id, mat[i]!]));

    const twins = topTwins("A", vectors, 2);
    expect(twins.length).toBe(2);
    expect(twins.map((t) => t.fundId)).not.toContain("A"); // excludes self
    expect(twins[0]!.fundId).toBe("B"); // nearest neighbour
    // deterministic: same inputs → same output
    expect(topTwins("A", vectors, 2)).toEqual(twins);
  });
});

describe("overlapScore", () => {
  const A = [h("AAA", 0.4), h("BBB", 0.3), h("CCC", 0.3)];
  const B = [h("AAA", 0.5), h("BBB", 0.2), h("DDD", 0.3)];
  it("is Σ min(wA,wB) over shared names, ×100, symmetric and bounded", () => {
    // shared: AAA min(.4,.5)=.4, BBB min(.3,.2)=.2 → .6 → 60
    expect(overlapScore(A, B)).toBeCloseTo(60, 6);
    expect(overlapScore(B, A)).toBeCloseTo(60, 6); // symmetric
    expect(overlapScore(A, A)).toBeCloseTo(100, 6); // identical book → 100
    expect(overlapScore(A, [h("ZZZ", 1)])).toBeCloseTo(0, 6); // disjoint → 0
  });
});

describe("percentileInSet", () => {
  it("renders too-small below peer_min_size", () => {
    const set = [1, 2, 3, 4]; // n=4 < 5
    const r = percentileInSet(3, set);
    expect(r.tooSmall).toBe(true);
    expect(r.percentile).toBeNull();
  });
  it("ranks within a sufficient set", () => {
    const set = [10, 20, 30, 40, 50];
    expect(percentileInSet(45, set).percentile).toBe(80); // 4 below → 80th
    expect(percentileInSet(5, set).percentile).toBe(0);
    expect(percentileInSet(55, set).percentile).toBe(100);
  });
});

describe("differentiatedIdeas", () => {
  it("returns names above the floor that no peer holds above the floor, by weight desc", () => {
    const fund = [h("UNIQ1", 0.05), h("SHARED", 0.03), h("UNIQ2", 0.03), h("DUST", 0.001)];
    const peers = [
      [h("SHARED", 0.04), h("OTHER", 0.02)],
      [h("UNIQ2", 0.001)], // holds UNIQ2 but BELOW the 25bps floor → still differentiated
    ];
    const ideas = differentiatedIdeas(fund, peers);
    expect(ideas).toEqual(["UNIQ1", "UNIQ2"]); // SHARED excluded (peer ≥floor); DUST below floor
  });
  it("respects the fund-side floor too", () => {
    const fund = [h("DUST", CFG.diff_ideas_min_bps / 10_000 - 0.00001)];
    expect(differentiatedIdeas(fund, [])).toEqual([]);
  });
});
