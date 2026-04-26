/**
 * Tests for the factor coverage check (`computeFactorCoverage`).
 */
import { describe, it, expect } from "vitest";
import { computeFactorCoverage } from "../../src/lib/factors/regression/coverage";
import type { FactorCode } from "../../src/types/factors";

function makeDates(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function buildSeries(dates: string[], value = 0.001): Map<string, number> {
  return new Map(dates.map((d) => [d, value]));
}

describe("computeFactorCoverage", () => {
  const allDates = makeDates("2024-01-02", 300); // ~300 trading days

  it("flags a factor as INSUFFICIENT_HISTORY when its inception is after the window start", () => {
    // EQ has full history; TREND only has the last 50 dates
    const eqDates = allDates;
    const trendDates = allDates.slice(-50);
    const perFactorByDate = new Map<FactorCode, Map<string, number>>([
      ["EQ", buildSeries(eqDates)],
      ["TREND", buildSeries(trendDates)],
    ]);

    const result = computeFactorCoverage({
      factorCodes: ["EQ", "TREND"],
      dates: allDates,
      perFactorByDate,
      window: 252,
    });

    expect(result.usableFactors).toContain("EQ");
    expect(result.usableFactors).not.toContain("TREND");
    const trendCov = result.coverage.find((c) => c.code === "TREND");
    expect(trendCov?.status).toBe("INSUFFICIENT_HISTORY");
    expect(trendCov?.inceptionDate).toBe(trendDates[0]);
  });

  it("flags a factor as MISSING_DATA when it has no data at all", () => {
    const perFactorByDate = new Map<FactorCode, Map<string, number>>([
      ["EQ", buildSeries(allDates)],
    ]);
    const result = computeFactorCoverage({
      factorCodes: ["EQ", "BAB"],
      dates: allDates,
      perFactorByDate,
      window: 60,
    });
    const babCov = result.coverage.find((c) => c.code === "BAB");
    expect(babCov?.status).toBe("MISSING_DATA");
    expect(babCov?.observationsAvailable).toBe(0);
  });

  it("returns aligned dates as the intersection across usable factors", () => {
    const eqDates = allDates;
    // RATES is missing every 5th day
    const ratesDates = allDates.filter((_, i) => i % 5 !== 0);
    const perFactorByDate = new Map<FactorCode, Map<string, number>>([
      ["EQ", buildSeries(eqDates)],
      ["RATES", buildSeries(ratesDates)],
    ]);
    const result = computeFactorCoverage({
      factorCodes: ["EQ", "RATES"],
      dates: allDates,
      perFactorByDate,
      window: 100,
      // 80% obs is enough to be OK even though we drop every 5th day
      minObsRatio: 0.7,
    });
    expect(result.usableFactors).toEqual(["EQ", "RATES"]);
    // Aligned dates should be 100-window intersection (~80 days because every 5th missing)
    expect(result.alignedWindowDates.length).toBeGreaterThan(70);
    expect(result.alignedWindowDates.length).toBeLessThan(100);
  });

  it("uses the last `window` dates from the data set", () => {
    const perFactorByDate = new Map<FactorCode, Map<string, number>>([
      ["EQ", buildSeries(allDates)],
    ]);
    const result = computeFactorCoverage({
      factorCodes: ["EQ"],
      dates: allDates,
      perFactorByDate,
      window: 50,
    });
    expect(result.alignedWindowDates).toHaveLength(50);
    expect(result.alignedWindowDates[0]).toBe(allDates[allDates.length - 50]);
    expect(result.alignedWindowDates[49]).toBe(allDates[allDates.length - 1]);
  });

  it("handles empty inputs gracefully", () => {
    const result = computeFactorCoverage({
      factorCodes: [],
      dates: [],
      perFactorByDate: new Map(),
      window: 252,
    });
    expect(result.usableFactors).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.alignedWindowDates).toEqual([]);
  });
});
