/**
 * rank-factor-movers — pins the pure ranking contract used by the Factor Top
 * Movers section: top-N positive (desc), top-N negative (asc), non-finite
 * values dropped, and an accurate heat range over the finite values.
 */
import { describe, it, expect } from "vitest";
import { splitTopMovers } from "../../src/lib/factors/per-stock/rank-factor-movers";
import type { FactorTopMoverEntry } from "../../src/types/factors";

function entry(ticker: string, value: number): FactorTopMoverEntry {
  return { ticker, name: ticker, sector: "Tech", subTheme: "Sub", value };
}

describe("splitTopMovers", () => {
  it("splits into positive (desc) and negative (asc)", () => {
    const res = splitTopMovers(
      [entry("A", 0.03), entry("B", -0.05), entry("C", 0.01), entry("D", -0.02)],
      20,
    );
    expect(res.positive.map((e) => e.ticker)).toEqual(["A", "C"]);
    expect(res.negative.map((e) => e.ticker)).toEqual(["B", "D"]);
  });

  it("caps each list at the limit", () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`P${i}`, i + 1)).concat(
      Array.from({ length: 30 }, (_, i) => entry(`N${i}`, -(i + 1))),
    );
    const res = splitTopMovers(entries, 20);
    expect(res.positive).toHaveLength(20);
    expect(res.negative).toHaveLength(20);
    // Most positive first.
    expect(res.positive[0]!.value).toBe(30);
    // Most negative first.
    expect(res.negative[0]!.value).toBe(-30);
  });

  it("drops non-finite values from both lists and the range", () => {
    const res = splitTopMovers(
      [
        entry("A", 0.02),
        entry("B", Number.NaN),
        entry("C", Number.POSITIVE_INFINITY),
        entry("D", -0.04),
      ],
      20,
    );
    expect(res.positive.map((e) => e.ticker)).toEqual(["A"]);
    expect(res.negative.map((e) => e.ticker)).toEqual(["D"]);
    expect(res.range).toEqual({ min: -0.04, max: 0.02 });
  });

  it("excludes zero from both positive and negative lists", () => {
    const res = splitTopMovers([entry("A", 0), entry("B", 0.01)], 20);
    expect(res.positive.map((e) => e.ticker)).toEqual(["B"]);
    expect(res.negative).toHaveLength(0);
  });

  it("returns a zero range for empty input", () => {
    const res = splitTopMovers([], 20);
    expect(res.positive).toHaveLength(0);
    expect(res.negative).toHaveLength(0);
    expect(res.range).toEqual({ min: 0, max: 0 });
  });
});
