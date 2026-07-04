import { describe, expect, it } from "vitest";
import {
  rankStockRotation,
  shrunkDiffusionPct,
  stockRankScore,
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
