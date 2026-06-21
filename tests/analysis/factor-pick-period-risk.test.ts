/**
 * Tests for the period-sliced realised variance decomposition that powers
 * the portfolio Variance waterfall when the Attribution Period control is
 * set to a trailing slice (1D…1Y).
 */
import { describe, it, expect } from "vitest";
import { pickPeriodRiskSummary } from "../../src/lib/factors/attribution/pick-period-risk";
import type {
  AttributionDayPoint,
  AttributionResult,
  FactorCode,
} from "../../src/types/factors";

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

function emptyAttribution(daily: AttributionDayPoint[]): AttributionResult {
  return {
    daily,
    cumulative: [],
    periods: [],
    dailyLog: null,
    cumulativeLog: null,
    periodsLog: null,
    provenanceBadge: null,
  };
}

/** Build a daily series with deterministic per-factor contributions. */
function makeDaily(
  dates: string[],
  factorAmplitudes: Partial<Record<FactorCode, number>>,
  alphaAmplitude: number,
): AttributionDayPoint[] {
  return dates.map((date, i) => {
    const byFactor: Record<string, number> = {};
    let factorSum = 0;
    for (const [code, amp] of Object.entries(factorAmplitudes)) {
      const c = (amp ?? 0) * Math.sin(i / 3);
      byFactor[code] = c;
      factorSum += c;
    }
    const alpha = alphaAmplitude * Math.cos(i / 5);
    return {
      date,
      portExcessReturn: factorSum + alpha,
      rfContrib: 0,
      byFactor: byFactor as Record<FactorCode, number>,
      alpha,
    };
  });
}

describe("pickPeriodRiskSummary", () => {
  const factorCodes = ["EQ", "MOM"] as FactorCode[];
  const dates = makeDates("2024-01-02", 60);

  it("returns null when attribution is missing or daily empty", () => {
    expect(pickPeriodRiskSummary(null, "5D", factorCodes)).toBeNull();
    expect(pickPeriodRiskSummary(undefined, "1Y", factorCodes)).toBeNull();
    expect(pickPeriodRiskSummary(emptyAttribution([]), "5D", factorCodes)).toBeNull();
  });

  it("returns null when the period slice has fewer than 2 obs", () => {
    const daily = makeDaily(dates, { EQ: 0.01 }, 0.002);
    // 1D is a single-obs slice — realised variance is undefined.
    expect(pickPeriodRiskSummary(emptyAttribution(daily), "1D", factorCodes)).toBeNull();
  });

  it("factor + idio shares sum to 1 over a 5D slice", () => {
    const daily = makeDaily(dates, { EQ: 0.01, MOM: 0.005 }, 0.003);
    const r = pickPeriodRiskSummary(emptyAttribution(daily), "5D", factorCodes)!;
    expect(r).not.toBeNull();
    expect(r.observations).toBe(5);
    const factorSum = r.byFactor.reduce((s, f) => s + f.share, 0);
    expect(factorSum + r.idioShare).toBeCloseTo(1, 12);
    expect(r.systematicShare + r.idioShare).toBeCloseTo(1, 12);
  });

  it("realised vol scales with the synthetic variance amplitude", () => {
    const lowDaily = makeDaily(dates, { EQ: 0.005 }, 0.001);
    const highDaily = makeDaily(dates, { EQ: 0.05 }, 0.01);
    const lo = pickPeriodRiskSummary(emptyAttribution(lowDaily), "1M", factorCodes)!;
    const hi = pickPeriodRiskSummary(emptyAttribution(highDaily), "1M", factorCodes)!;
    expect(hi.realizedAnnualizedVol).toBeGreaterThan(lo.realizedAnnualizedVol);
    // The high series uses amplitudes ~10× larger; realised vol should
    // scale roughly proportionally (within sample-noise tolerance).
    const ratio = hi.realizedAnnualizedVol / lo.realizedAnnualizedVol;
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(15);
  });

  it("factor shares reflect relative contribution magnitudes", () => {
    // EQ contributions are 4× MOM contributions — so its share should
    // dominate. (4² = 16× in variance space.)
    const daily = makeDaily(dates, { EQ: 0.02, MOM: 0.005 }, 0.001);
    const r = pickPeriodRiskSummary(emptyAttribution(daily), "1M", factorCodes)!;
    const eq = r.byFactor.find((f) => f.code === "EQ")!;
    const mom = r.byFactor.find((f) => f.code === "MOM")!;
    expect(eq.share).toBeGreaterThan(mom.share);
    expect(eq.share / Math.max(mom.share, 1e-12)).toBeGreaterThan(8);
  });

  it("idiosyncratic share dominates when alpha noise overwhelms factor signal", () => {
    const daily = makeDaily(dates, { EQ: 0.001 }, 0.05);
    const r = pickPeriodRiskSummary(emptyAttribution(daily), "1M", factorCodes)!;
    expect(r.idioShare).toBeGreaterThan(0.9);
  });
});
