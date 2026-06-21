/**
 * Tests for the static-beta (horizon end-fit) daily attribution that powers
 * the period-driven portfolio decomposition panels. Unlike the rolling-fit
 * series, this is defined for EVERY aligned date so trailing reporting periods
 * (1D…1Y) resolve at any horizon instead of collapsing to a single point.
 */
import { describe, it, expect } from "vitest";
import { computeStaticBetaDailyAttribution } from "../../src/lib/factors/attribution/daily";
import { computeStaticBetaDailyLogAttribution } from "../../src/lib/factors/attribution/daily-log";
import { computePeriodAttribution } from "../../src/lib/factors/attribution/period";
import type { FactorCode } from "../../src/types/factors";

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

describe("computeStaticBetaDailyAttribution", () => {
  const factorCodes = ["EQ", "MOM"] as FactorCode[];
  const betas = [1.2, -0.4];
  const dates = makeDates("2023-01-02", 300);

  const factorMap = new Map(
    dates.map((d, i) => [
      d,
      { EQ: 0.01 * Math.sin(i / 4), MOM: 0.008 * Math.cos(i / 7) } as Record<string, number>,
    ]),
  );
  const portTotalMap = new Map(dates.map((d, i) => [d, 0.012 * Math.sin(i / 5)]));
  const rfMap = new Map(dates.map((d) => [d, 0.0001]));

  it("is defined for EVERY aligned date (not gated by burn-in)", () => {
    const daily = computeStaticBetaDailyAttribution(
      dates,
      betas,
      factorCodes,
      factorMap,
      portTotalMap,
      rfMap,
    );
    expect(daily).toHaveLength(dates.length);
  });

  it("identity: portExcess = Σ (β·factor) + alpha, with a FIXED beta vector", () => {
    const daily = computeStaticBetaDailyAttribution(
      dates,
      betas,
      factorCodes,
      factorMap,
      portTotalMap,
      rfMap,
    );
    for (let i = 0; i < daily.length; i++) {
      const d = daily[i]!;
      const factorSum = Object.values(d.byFactor).reduce((s, v) => s + v, 0);
      expect(d.alpha + factorSum).toBeCloseTo(d.portExcessReturn, 10);
      // Beta is fixed across dates: contribution = β × factor return.
      expect(d.byFactor.EQ).toBeCloseTo(betas[0]! * (factorMap.get(d.date)!.EQ ?? 0), 12);
      expect(d.byFactor.MOM).toBeCloseTo(betas[1]! * (factorMap.get(d.date)!.MOM ?? 0), 12);
      // portExcess = portTotal − rf.
      expect(d.portExcessReturn).toBeCloseTo(portTotalMap.get(d.date)! - 0.0001, 12);
    }
  });

  it("skips dates absent from portTotalMap", () => {
    const partialPort = new Map(portTotalMap);
    partialPort.delete(dates[10]!);
    const daily = computeStaticBetaDailyAttribution(
      dates,
      betas,
      factorCodes,
      factorMap,
      partialPort,
      rfMap,
    );
    expect(daily).toHaveLength(dates.length - 1);
    expect(daily.some((d) => d.date === dates[10])).toBe(false);
  });

  it("REGRESSION: period buckets differ across 1M/3M/6M/1Y on a long series", () => {
    // The whole point of the fix: a full-length series lets each trailing
    // period cover a different number of days, so the totals must differ.
    const daily = computeStaticBetaDailyAttribution(
      dates,
      betas,
      factorCodes,
      factorMap,
      portTotalMap,
      rfMap,
    );
    const periods = computePeriodAttribution(daily, factorCodes);
    const byLabel = new Map(periods.map((p) => [p.label, p]));
    const oneM = byLabel.get("1M")!.totalReturn;
    const threeM = byLabel.get("3M")!.totalReturn;
    const sixM = byLabel.get("6M")!.totalReturn;
    const oneY = byLabel.get("1Y")!.totalReturn;
    // Distinct slices ⇒ distinct totals (guards against the single-point
    // collapse that made the panel static).
    const totals = [oneM, threeM, sixM, oneY];
    const unique = new Set(totals.map((t) => t.toFixed(8)));
    expect(unique.size).toBe(totals.length);
    // Wider windows cover strictly more observations.
    expect(byLabel.get("1Y")!.startDate < byLabel.get("6M")!.startDate).toBe(true);
    expect(byLabel.get("6M")!.startDate < byLabel.get("3M")!.startDate).toBe(true);
  });
});

describe("computeStaticBetaDailyLogAttribution", () => {
  const factorCodes = ["EQ"] as FactorCode[];
  const betas = [0.9];
  const dates = makeDates("2023-01-02", 120);

  // Realized simple stock excess returns; the log series is ln(1+r).
  const simpleExcess = dates.map((_, i) => 0.01 * Math.sin(i / 6));
  const factorLogMap = new Map(
    dates.map((d, i) => [d, { EQ: Math.log(1 + 0.008 * Math.cos(i / 5)) } as Record<string, number>]),
  );
  const portExcessLogMap = new Map(dates.map((d, i) => [d, Math.log(1 + simpleExcess[i]!)]));
  const rfLogMap = new Map(dates.map((d) => [d, Math.log(1 + 0.0001)]));

  it("exp(Σ y_log) − 1 reconciles to the compounded realised excess", () => {
    const daily = computeStaticBetaDailyLogAttribution(
      dates,
      betas,
      factorCodes,
      factorLogMap,
      portExcessLogMap,
      rfLogMap,
    );
    expect(daily).toHaveLength(dates.length);
    const sumLog = daily.reduce((s, d) => s + d.portExcessLogReturn, 0);
    const geometric = Math.exp(sumLog) - 1;
    const compounded = simpleExcess.reduce((acc, r) => acc * (1 + r), 1) - 1;
    expect(geometric).toBeCloseTo(compounded, 12);
  });

  it("log identity: y_log = Σ (β·x_log) + alpha per day", () => {
    const daily = computeStaticBetaDailyLogAttribution(
      dates,
      betas,
      factorCodes,
      factorLogMap,
      portExcessLogMap,
      rfLogMap,
    );
    for (const d of daily) {
      const factorSum = Object.values(d.byFactor).reduce((s, v) => s + v, 0);
      expect(d.alpha + factorSum).toBeCloseTo(d.portExcessLogReturn, 12);
    }
  });
});
