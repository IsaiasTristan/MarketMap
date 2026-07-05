import { describe, expect, it } from "vitest";
import {
  rankStockRotation,
  shrunkDiffusionPct,
  stockRankScore,
  diffusionContext,
  participationWeightedMean,
  rescaleScore0to100,
  dominantConcentration,
  diffusionDollarsDiverge,
  type StockRotationInput,
} from "@/lib/institutional/stock-rotation";

function row(ticker: string, over: Partial<StockRotationInput> = {}): StockRotationInput {
  return {
    ticker,
    companyName: ticker,
    sector: "Tech",
    marketCapTier: "mid",
    fundsIn: 0,
    fundsOut: 0,
    fundsParticipating: 10,
    activeBpsAvg: 100,
    dollarNetFlow: 0,
    fundsBought: 0,
    fundsSold: 0,
    fundsHolding: 10,
    ...over,
  };
}

describe("shrunkDiffusionPct", () => {
  it("a 3-of-3 name reads 43%, not 100% (k=4)", () => {
    expect(shrunkDiffusionPct(3, 0, 3, 4)).toBeCloseTo(42.86, 1);
  });
  it("a broadly-held 20-of-25 name outreads it", () => {
    expect(shrunkDiffusionPct(20, 0, 25, 4)).toBeGreaterThan(shrunkDiffusionPct(3, 0, 3, 4));
  });
  it("is 0 when nobody participates", () => {
    expect(shrunkDiffusionPct(0, 0, 0, 4)).toBe(0);
  });
});

describe("rankStockRotation", () => {
  const opts = { minParticipants: 5, k: 4, boardSize: 15, sizeFilter: "all" as const };

  it("orders the accumulation board by rank score, NOT alphabetically", () => {
    // Alphabetical tickers with rank score INCREASING toward the end of the
    // alphabet, so a correct sort is (near) reverse-alphabetical.
    const rows = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((t, i) =>
      row(t, { fundsIn: 3 + i, fundsOut: 0, fundsParticipating: 10, activeBpsAvg: 100 }),
    );
    const { accumulation } = rankStockRotation(rows, opts);
    const tickers = accumulation.map((r) => r.ticker);
    const alpha = [...tickers].sort();
    expect(tickers.slice(0, 5)).not.toEqual(alpha.slice(0, 5));
    expect(tickers[0]).toBe("FFF"); // highest fundsIn → highest rank score
    // strictly descending rank score
    for (let i = 1; i < accumulation.length; i++) {
      expect(accumulation[i - 1]!.rankScore).toBeGreaterThanOrEqual(accumulation[i]!.rankScore);
    }
  });

  it("breaks rank-score ties by |net $|, then ticker — never alphabetical alone", () => {
    // Two identical-score names; the one with bigger |$| must rank first even
    // though its ticker sorts later.
    const rows = [
      row("AAA", { fundsIn: 6, fundsOut: 0, fundsParticipating: 10, activeBpsAvg: 100, dollarNetFlow: 1_000 }),
      row("ZZZ", { fundsIn: 6, fundsOut: 0, fundsParticipating: 10, activeBpsAvg: 100, dollarNetFlow: 9_000 }),
    ];
    const { accumulation } = rankStockRotation(rows, opts);
    expect(accumulation[0]!.ticker).toBe("ZZZ");
  });

  it("excludes names below the participation floor from boards but keeps them searchable", () => {
    const rows = [
      row("BIG", { fundsIn: 6, fundsParticipating: 10 }),
      row("TINY", { fundsIn: 3, fundsParticipating: 3 }), // below floor of 5
    ];
    const res = rankStockRotation(rows, opts);
    expect(res.accumulation.map((r) => r.ticker)).toContain("BIG");
    expect(res.accumulation.map((r) => r.ticker)).not.toContain("TINY");
    expect(res.searchable.map((r) => r.ticker)).toContain("TINY");
    expect(res.qualifying).toBe(1);
  });

  it("puts the strongest distribution (most negative) first", () => {
    const rows = [
      row("MILD", { fundsIn: 0, fundsOut: 3, fundsParticipating: 10, activeBpsAvg: 100 }),
      row("HARSH", { fundsIn: 0, fundsOut: 9, fundsParticipating: 10, activeBpsAvg: 100 }),
    ];
    const { distribution } = rankStockRotation(rows, opts);
    expect(distribution[0]!.ticker).toBe("HARSH");
  });

  it("applies the size filter (mega-only / ex-mega)", () => {
    const rows = [
      row("MEGA", { fundsIn: 8, marketCapTier: "mega" }),
      row("SMALL", { fundsIn: 8, marketCapTier: "small" }),
    ];
    expect(rankStockRotation(rows, { ...opts, sizeFilter: "mega-only" }).accumulation.map((r) => r.ticker)).toEqual(["MEGA"]);
    expect(rankStockRotation(rows, { ...opts, sizeFilter: "ex-mega" }).accumulation.map((r) => r.ticker)).toEqual(["SMALL"]);
  });

  it("rank score sign follows the diffusion sign", () => {
    expect(stockRankScore(50, 10, 100)).toBeGreaterThan(0);
    expect(stockRankScore(-50, 10, 100)).toBeLessThan(0);
    expect(stockRankScore(50, 10, 0)).toBe(0); // no magnitude → no score
  });
});

describe("participationWeightedMean + demeaning (Part 1a)", () => {
  it("weights by participation, and the weighted Σ of deviations is ~0", () => {
    const rows = [
      { value: -20, weight: 100 },
      { value: 10, weight: 50 },
      { value: 40, weight: 10 },
    ];
    const mean = participationWeightedMean(rows);
    // (−20·100 + 10·50 + 40·10) / 160 = (−2000 + 500 + 400)/160 = −6.875
    expect(mean).toBeCloseTo(-6.875, 3);
    const weightedSumDev = rows.reduce((s, r) => s + (r.value - mean) * r.weight, 0);
    expect(weightedSumDev).toBeCloseTo(0, 6);
  });
  it("is 0 for an empty or zero-weight set", () => {
    expect(participationWeightedMean([])).toBe(0);
    expect(participationWeightedMean([{ value: 5, weight: 0 }])).toBe(0);
  });
  it("demeaning flips an all-negative board to a mix of signs", () => {
    // Every raw sector is negative (the all-red board) but they differ; demeaning
    // makes the least-negative sectors read positive relative to the average.
    const raw = [-30, -20, -10].map((v, i) => ({ value: v, weight: 10 * (i + 1) }));
    const mean = participationWeightedMean(raw);
    const demeaned = raw.map((r) => r.value - mean);
    expect(demeaned.some((v) => v > 0)).toBe(true);
    expect(demeaned.some((v) => v < 0)).toBe(true);
  });
});

describe("rescaleScore0to100 (Part 3)", () => {
  it("maps the most extreme |score| to 100 and preserves magnitude order", () => {
    expect(rescaleScore0to100([50, -100, 25])).toEqual([50, 100, 25]);
  });
  it("returns all-zero for an all-zero board", () => {
    expect(rescaleScore0to100([0, 0])).toEqual([0, 0]);
  });
  it("the rendered board order matches the visible score column (never sorts by a hidden key)", () => {
    // Sort by rank score (the accumulation board's key), then rescale for display.
    // The visible score column must be non-increasing down the board.
    const rows = ["AAA", "BBB", "CCC", "DDD"].map((t, i) => row(t, { fundsIn: 4 + i, fundsOut: 0, fundsParticipating: 12, activeBpsAvg: 80 }));
    const { accumulation } = rankStockRotation(rows, { minParticipants: 5, k: 4, boardSize: 15, sizeFilter: "all" });
    const scores = rescaleScore0to100(accumulation.map((r) => r.rankScore));
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    expect(scores[0]).toBe(100); // top of the board reads 100
  });
});

describe("dominantConcentration (Part 4)", () => {
  const items = (spec: Array<[string, number]>) => spec.map(([ticker, dollarNetFlow]) => ({ ticker, dollarNetFlow }));
  it("flags the dominant name when its |$| share ≥ threshold", () => {
    // NVDA = 82% of the |$| of a 4-name subsector.
    const c = dominantConcentration(items([["NVDA", 8200], ["AMD", 1000], ["AVGO", 500], ["MU", 300]]), 60);
    expect(c).toEqual({ ticker: "NVDA", pct: 82 });
  });
  it("does not flag a well-spread bucket", () => {
    expect(dominantConcentration(items([["A", 100], ["B", 100], ["C", 100]]), 60)).toBeNull();
  });
  it("returns null for an empty or flat bucket", () => {
    expect(dominantConcentration([], 60)).toBeNull();
    expect(dominantConcentration(items([["A", 0], ["B", 0]]), 60)).toBeNull();
  });
});

describe("diffusionDollarsDiverge (Part 5 marker regression)", () => {
  const MIN_DIFF = 10;
  const MIN_$ = 100_000_000;
  it("fires when breadth is positive but dollars negative, both above floors", () => {
    expect(diffusionDollarsDiverge(33, -200_000_000, MIN_DIFF, MIN_$)).toBe(true);
  });
  it("does NOT fire when either side is below its floor", () => {
    expect(diffusionDollarsDiverge(5, -200_000_000, MIN_DIFF, MIN_$)).toBe(false); // diffusion below floor
    expect(diffusionDollarsDiverge(33, -50_000_000, MIN_DIFF, MIN_$)).toBe(false); // dollars below floor
  });
  it("does NOT fire when signs agree", () => {
    expect(diffusionDollarsDiverge(33, 200_000_000, MIN_DIFF, MIN_$)).toBe(false);
  });
});

describe("diffusionContext (ghost tick + percentile)", () => {
  const series = [
    { period: "2024-03-31", value: 10 },
    { period: "2024-06-30", value: -5 },
    { period: "2024-09-30", value: 20 },
    { period: "2024-12-31", value: 40 },
  ];
  it("returns last quarter's value as the ghost prior", () => {
    expect(diffusionContext(series, "2024-12-31").prior).toBe(20);
    expect(diffusionContext(series, "2024-03-31").prior).toBeNull(); // no prior
  });
  it("returns the trailing 4-quarter history up to the current period", () => {
    expect(diffusionContext(series, "2024-12-31").history).toEqual([10, -5, 20, 40]);
    expect(diffusionContext(series, "2024-09-30").history).toEqual([10, -5, 20]);
  });
  it("percentile ranks current |diffusion| within the trailing distribution", () => {
    // |40| is the largest of {10,5,20,40} → 100th percentile.
    expect(diffusionContext(series, "2024-12-31").percentile).toBe(100);
    // |10| ranks above only {10,5} of {10,5,20} at that point... needs 4+ points.
    expect(diffusionContext(series, "2024-09-30").percentile).toBeNull(); // <4 points
  });
});
