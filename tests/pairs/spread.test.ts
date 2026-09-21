import { describe, expect, it } from "vitest";
import {
  basketWeeklyReturns,
  hedgeEfficiency,
  indexFromReturns,
  priceRatioSeries,
  priceRatioZ,
  relReturn,
  spreadRisk,
  weeklyReturnsFromCloses,
} from "@/lib/pairs/spread";

describe("weeklyReturnsFromCloses", () => {
  it("computes simple week-over-week returns, first is null", () => {
    const r = weeklyReturnsFromCloses([100, 110, 99]);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(0.1, 10);
    expect(r[2]).toBeCloseTo(-0.1, 10);
  });
});

describe("basketWeeklyReturns", () => {
  it("equal-weights across members present that week", () => {
    const r = basketWeeklyReturns([
      [null, 0.1, 0.2],
      [null, 0.3, null],
    ]);
    expect(r[1]).toBeCloseTo(0.2, 10); // mean(0.1, 0.3)
    expect(r[2]).toBeCloseTo(0.2, 10); // only member A present
  });
  it("cap-weights when weights supplied", () => {
    const r = basketWeeklyReturns(
      [
        [null, 0.1],
        [null, 0.3],
      ],
      [75, 25],
    );
    expect(r[1]).toBeCloseTo(0.1 * 0.75 + 0.3 * 0.25, 10);
  });
});

describe("indexFromReturns / priceRatioSeries", () => {
  it("compounds an index from 100 and treats nulls as flat", () => {
    const idx = indexFromReturns([null, 0.1, null, -0.5]);
    expect(idx[0]).toBe(100);
    expect(idx[1]).toBeCloseTo(110, 6);
    expect(idx[2]).toBeCloseTo(110, 6);
    expect(idx[3]).toBeCloseTo(55, 6);
  });
  it("ratios two indices", () => {
    const r = priceRatioSeries([100, 110], [100, 100]);
    expect(r[1]).toBeCloseTo(1.1, 10);
  });
});

describe("relReturn", () => {
  it("is long compound minus short compound over the window", () => {
    const long = [0.1, 0.1];
    const short = [0.05, 0.05];
    const lc = 1.1 * 1.1 - 1;
    const sc = 1.05 * 1.05 - 1;
    expect(relReturn(long, short, 2)).toBeCloseTo(lc - sc, 10);
  });
});

describe("hedgeEfficiency", () => {
  it("is ~1 for identical legs (all spread risk cancels)", () => {
    const r = Array.from({ length: 30 }, (_, i) => Math.sin(i));
    expect(hedgeEfficiency(r, r)!).toBeCloseTo(1, 6);
  });
  it("is ~0 for independent legs of equal variance", () => {
    // Orthogonal deterministic series with equal variance: cov ~ 0.
    const a = Array.from({ length: 200 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 200 }, (_, i) => Math.cos(i));
    const eff = hedgeEfficiency(a, b)!;
    expect(Math.abs(eff)).toBeLessThan(0.1);
  });
  it("penalises a volatility mismatch (below plain correlation)", () => {
    // Perfectly correlated but the short leg is 3x the vol: corr=1 but efficiency < 1.
    const base = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3));
    const long = base;
    const short = base.map((x) => 3 * x);
    const eff = hedgeEfficiency(long, short)!;
    expect(eff).toBeLessThan(1);
    expect(eff).toBeGreaterThan(0);
  });
  it("is negative when the legs move oppositely (hedge doubles risk)", () => {
    const base = Array.from({ length: 60 }, (_, i) => Math.sin(i / 4));
    const eff = hedgeEfficiency(base, base.map((x) => -x))!;
    expect(eff).toBeLessThan(0);
  });
  it("is null with too few aligned weeks", () => {
    expect(hedgeEfficiency([0.1, null], [0.1, 0.2])).toBeNull();
  });
});

describe("spreadRisk", () => {
  it("reports annualized vol, a non-positive drawdown, worst week and leg correlation", () => {
    const long = Array.from({ length: 60 }, (_, i) => 0.01 * Math.sin(i / 5));
    const short = Array.from({ length: 60 }, (_, i) => 0.01 * Math.sin(i / 5 + 0.3));
    const r = spreadRisk(long, short);
    expect(r.annualizedVol).toBeGreaterThan(0);
    expect(r.maxDrawdown!).toBeLessThanOrEqual(0);
    expect(r.legCorrelation!).toBeGreaterThan(0.5);
  });
});

describe("priceRatioZ", () => {
  it("z-scores the latest ratio against its own history", () => {
    const series = [1, 1, 1, 1, 1, 1, 1, 2]; // last point is far above the mean
    expect(priceRatioZ(series)!).toBeGreaterThan(1.5);
  });
  it("is null with a flat history", () => {
    expect(priceRatioZ([1, 1, 1, 1, 1, 1, 1, 1])).toBeNull();
  });
});
