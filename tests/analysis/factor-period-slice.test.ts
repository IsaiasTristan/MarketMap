/**
 * Tests for the shared period-slice resolver and the portfolio period picker.
 */
import { describe, it, expect } from "vitest";
import { resolvePeriodSlice } from "../../src/lib/factors/attribution/period";
import { pickPeriodSummary } from "../../src/lib/factors/attribution/pick-period-summary";
import type { AttributionResult } from "../../src/types/factors";

/** Build a contiguous run of trading-day-ish dates (skips weekends loosely). */
function makeDates(startIso: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startIso}T00:00:00Z`);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("resolvePeriodSlice", () => {
  it("returns empty sentinel for empty input", () => {
    const s = resolvePeriodSlice([], "1Y");
    expect(s).toEqual({ startIndex: -1, endIndex: -1, startDate: "", endDate: "" });
  });

  it("1D selects the last single observation (count-based)", () => {
    const dates = makeDates("2024-01-01", 30);
    const s = resolvePeriodSlice(dates, "1D");
    expect(s.startIndex).toBe(dates.length - 1);
    expect(s.endIndex).toBe(dates.length - 1);
    expect(s.startDate).toBe(dates[dates.length - 1]);
  });

  it("5D selects the last five observations (count-based)", () => {
    const dates = makeDates("2024-01-01", 30);
    const s = resolvePeriodSlice(dates, "5D");
    expect(s.endIndex - s.startIndex + 1).toBe(5);
    expect(s.endIndex).toBe(dates.length - 1);
  });

  it("count period clamps to available data when shorter than the count", () => {
    const dates = makeDates("2024-01-01", 3);
    const s = resolvePeriodSlice(dates, "5D");
    expect(s.startIndex).toBe(0);
    expect(s.endIndex).toBe(2);
  });

  it("1M uses a calendar offset from the last date", () => {
    // ~1 year of trading days; 1M should start ~21 obs before the end.
    const dates = makeDates("2023-06-01", 260);
    const s = resolvePeriodSlice(dates, "1M");
    expect(s.endIndex).toBe(dates.length - 1);
    const span = s.endIndex - s.startIndex + 1;
    // A month of business days is ~19-23; allow a generous band.
    expect(span).toBeGreaterThanOrEqual(17);
    expect(span).toBeLessThanOrEqual(25);
    // start date is on/after the calendar boundary
    const boundary = new Date(`${s.endDate}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth() - 1);
    expect(s.startDate >= boundary.toISOString().slice(0, 10)).toBe(true);
  });

  it("1Y over a one-year sample is the whole window", () => {
    const dates = makeDates("2024-06-13", 252);
    const s = resolvePeriodSlice(dates, "1Y");
    expect(s.startIndex).toBe(0);
    expect(s.endIndex).toBe(dates.length - 1);
  });
});

function emptyAttribution(over: Partial<AttributionResult>): AttributionResult {
  return {
    daily: [],
    cumulative: [],
    periods: [],
    dailyLog: null,
    cumulativeLog: null,
    periodsLog: null,
    provenanceBadge: null,
    ...over,
  };
}

describe("pickPeriodSummary", () => {
  const simpleOnly = emptyAttribution({
    periods: [
      {
        label: "1Y",
        startDate: "2024-01-02",
        endDate: "2024-12-31",
        totalReturn: 0.2,
        factorReturn: 0.15,
        rfReturn: 0.04,
        alpha: 0.01,
        byFactor: [{ code: "EQ", label: "Equity", contribution: 0.15, pct: 0.75 }],
      },
    ] as AttributionResult["periods"],
  });

  const withLog = emptyAttribution({
    periods: simpleOnly.periods,
    periodsLog: [
      {
        label: "1Y",
        startDate: "2024-01-02",
        endDate: "2024-12-31",
        totalLogReturn: 0.18,
        totalGeometricReturn: 0.197,
        factorLogReturn: 0.14,
        rfLogReturn: 0.039,
        alpha: 0.009,
        byFactor: [{ code: "EQ", label: "Equity", contribution: 0.14, pct: 0.78 }],
      },
    ] as AttributionResult["periodsLog"],
  });

  it("returns null when attribution is missing", () => {
    expect(pickPeriodSummary(null, "1Y", "log")).toBeNull();
    expect(pickPeriodSummary(undefined, "1Y", "simple")).toBeNull();
  });

  it("returns null when the requested label has no bucket", () => {
    expect(pickPeriodSummary(simpleOnly, "6M", "simple")).toBeNull();
  });

  it("simple mode uses the arithmetic bucket", () => {
    const p = pickPeriodSummary(simpleOnly, "1Y", "simple");
    expect(p).not.toBeNull();
    expect(p!.isLog).toBe(false);
    expect(p!.totalReturn).toBeCloseTo(0.2, 12);
    expect(p!.totalLogReturn).toBeNull();
  });

  it("log mode uses the geometric headline + log sub-line", () => {
    const p = pickPeriodSummary(withLog, "1Y", "log");
    expect(p!.isLog).toBe(true);
    expect(p!.totalReturn).toBeCloseTo(0.197, 12);
    expect(p!.totalLogReturn).toBeCloseTo(0.18, 12);
  });

  it("log mode falls back to the simple bucket when log is unavailable", () => {
    const p = pickPeriodSummary(simpleOnly, "1Y", "log");
    expect(p!.isLog).toBe(false);
    expect(p!.totalReturn).toBeCloseTo(0.2, 12);
  });
});
