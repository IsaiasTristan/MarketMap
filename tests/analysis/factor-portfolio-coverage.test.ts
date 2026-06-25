/**
 * Tests for coverage-weighted portfolio return construction.
 *
 * Pins the IPO-safe behaviour: a recently-listed (short-history) holding must
 * NOT truncate the whole portfolio's aligned window, the per-date weights are
 * renormalized to full investment across the present holdings, and the
 * coverage diagnostics correctly name the culprit ticker(s) and dropped dates.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverageWeightedReturns,
  type CoveragePositionInput,
} from "../../src/lib/factors/regression/portfolio-coverage";

function makeDates(n: number): string[] {
  const base = new Date("2024-01-01");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Build a price map for a position present on a contiguous tail of `dates`. */
function priceMap(dates: string[], startIdx: number, base = 100, step = 1): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = startIdx; i < dates.length; i++) m.set(dates[i]!, base + (i - startIdx) * step);
  return m;
}

describe("buildCoverageWeightedReturns (portfolio-coverage)", () => {
  it("a recent IPO does NOT truncate the aligned window", () => {
    const dates = makeDates(60);
    // Long-history holding spans all 60 days; IPO appears only in the last 5.
    const positions: CoveragePositionInput[] = [
      { ticker: "OLD", priceByDate: priceMap(dates, 0), firstDate: dates[0]!, weight: 0.7, gross: 70 },
      { ticker: "IPO", priceByDate: priceMap(dates, 55), firstDate: dates[55]!, weight: 0.3, gross: 30 },
    ];

    const { dates: outDates, returns, coverage } = buildCoverageWeightedReturns(dates, positions, 0.5);

    // Inner-join would have produced only ~4 days; union keeps ~59.
    expect(outDates.length).toBe(59);
    expect(returns.length).toBe(59);
    expect(coverage.alignedDates).toBe(59);
    expect(coverage.seriesStart).toBe(dates[1]);
    expect(coverage.seriesEnd).toBe(dates[59]);
  });

  it("names the short-history holding in coverage diagnostics", () => {
    const dates = makeDates(60);
    const positions: CoveragePositionInput[] = [
      { ticker: "OLD", priceByDate: priceMap(dates, 0), firstDate: dates[0]!, weight: 0.7, gross: 70 },
      { ticker: "IPO", priceByDate: priceMap(dates, 55), firstDate: dates[55]!, weight: 0.3, gross: 30 },
    ];

    const { coverage } = buildCoverageWeightedReturns(dates, positions, 0.5);

    expect(coverage.shortHistoryPositions).toHaveLength(1);
    expect(coverage.shortHistoryPositions[0]!.ticker).toBe("IPO");
    expect(coverage.shortHistoryPositions[0]!.firstDate).toBe(dates[55]);
    // Present on date-pairs from index 56..59 → 4 contributing days.
    expect(coverage.shortHistoryPositions[0]!.observations).toBe(4);
    expect(coverage.excludedPositions).toHaveLength(0);
  });

  it("renormalizes present weights to full investment on partial-coverage dates", () => {
    const dates = makeDates(3); // d0, d1, d2
    // OLD present all days; NEW present only on d1->d2. On the d0->d1 step only
    // OLD is present (gross 70 / 100 = 0.7 coverage >= 0.5), so its 1% move
    // must be scaled up by 1/0.7 to represent the fully-invested portfolio.
    const oldMap = new Map<string, number>([
      [dates[0]!, 100],
      [dates[1]!, 101],
      [dates[2]!, 101],
    ]);
    const newMap = new Map<string, number>([
      [dates[1]!, 200],
      [dates[2]!, 200],
    ]);
    const positions: CoveragePositionInput[] = [
      { ticker: "OLD", priceByDate: oldMap, firstDate: dates[0]!, weight: 0.7, gross: 70 },
      { ticker: "NEW", priceByDate: newMap, firstDate: dates[1]!, weight: 0.3, gross: 30 },
    ];

    const { dates: outDates, returns } = buildCoverageWeightedReturns(dates, positions, 0.5);

    expect(outDates).toEqual([dates[1], dates[2]]);
    // d0->d1: only OLD present, raw contribution 0.7 * (101-100)/100 = 0.007,
    // renormalized by coverage 0.7 → 0.01.
    expect(returns[0]!).toBeCloseTo(0.01, 12);
    // d1->d2: both flat → 0 return.
    expect(returns[1]!).toBeCloseTo(0, 12);
  });

  it("drops dates below the coverage threshold and counts them", () => {
    const dates = makeDates(4);
    // BIG present only on the last pair; SMALL present everywhere. Early pairs
    // have only SMALL (gross 10/110 ≈ 0.09 < 0.5) → dropped.
    const bigMap = new Map<string, number>([
      [dates[2]!, 100],
      [dates[3]!, 102],
    ]);
    const smallMap = priceMap(dates, 0, 50, 1);
    const positions: CoveragePositionInput[] = [
      { ticker: "BIG", priceByDate: bigMap, firstDate: dates[2]!, weight: 0.91, gross: 100 },
      { ticker: "SMALL", priceByDate: smallMap, firstDate: dates[0]!, weight: 0.09, gross: 10 },
    ];

    const { dates: outDates, coverage } = buildCoverageWeightedReturns(dates, positions, 0.5);

    // Only the final d2->d3 pair clears the threshold.
    expect(outDates).toEqual([dates[3]]);
    expect(coverage.droppedLowCoverageDates).toBe(2);
  });

  it("cash dilutes portfolio return as a zero-return drag", () => {
    const dates = makeDates(3);
    const stockMap = new Map<string, number>([
      [dates[0]!, 100],
      [dates[1]!, 110],
      [dates[2]!, 121],
    ]);
    const cashMap = new Map<string, number>([
      [dates[0]!, 1],
      [dates[1]!, 1],
      [dates[2]!, 1],
    ]);
    const positions: CoveragePositionInput[] = [
      { ticker: "STOCK", priceByDate: stockMap, firstDate: dates[0]!, weight: 0.5, gross: 50 },
      { ticker: "CASH", priceByDate: cashMap, firstDate: dates[0]!, weight: 0.5, gross: 50 },
    ];

    const { returns } = buildCoverageWeightedReturns(dates, positions, 0.5);

    expect(returns[0]).toBeCloseTo(0.05, 10);
    expect(returns[1]).toBeCloseTo(0.05, 10);
  });

  it("flags a position with no overlap as excluded", () => {
    const dates = makeDates(10);
    const positions: CoveragePositionInput[] = [
      { ticker: "OLD", priceByDate: priceMap(dates, 0), firstDate: dates[0]!, weight: 1, gross: 100 },
      { ticker: "GHOST", priceByDate: new Map(), firstDate: null, weight: 0, gross: 0 },
    ];

    const { coverage } = buildCoverageWeightedReturns(dates, positions, 0.5);

    expect(coverage.excludedPositions).toHaveLength(1);
    expect(coverage.excludedPositions[0]!.ticker).toBe("GHOST");
  });
});
