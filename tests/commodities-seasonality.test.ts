import { describe, expect, it } from "vitest";
import type { CurvePoint } from "@/types/commodities";
import { addMonths } from "@/lib/commodities/format";
import { gasSeasonality } from "@/lib/commodities/seasonality";

/** Builds a strip whose price is fixed per season for easy averaging. */
function seasonalStrip(start: string, months: number, shift = 0): CurvePoint[] {
  const priceFor = (key: string): number => {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7));
    // Winter anchored at the Nov year: Nov/Dec belong to WIN(y), Jan–Mar to WIN(y-1).
    if (m >= 11) return y === 2026 ? 5 : y === 2027 ? 6 : 7;
    if (m <= 3) return y === 2027 ? 5 : y === 2028 ? 6 : 7;
    if (m >= 4 && m <= 10) return y === 2027 ? 3 : y === 2028 ? 4 : 2;
    return 2;
  };
  return Array.from({ length: months }, (_, i) => {
    const contractMonth = addMonths(start, i);
    return { contractMonth, price: priceFor(contractMonth) + shift };
  });
}

describe("gasSeasonality", () => {
  it("emits WIN/SUM/WIN/SUM from the first winter at/after the strip start", () => {
    const latest = seasonalStrip("2026-08", 30); // through 2029-01
    const s = gasSeasonality(latest, null, "2026-07-13");
    expect(s.rows.map((r) => r.label)).toEqual([
      "WIN 26/27",
      "SUM 27",
      "WIN 27/28",
      "SUM 28",
    ]);
    expect(s.rows[0]!.price!).toBeCloseTo(5, 9); // Nov 26 – Mar 27
    expect(s.rows[1]!.price!).toBeCloseTo(3, 9); // Apr – Oct 27
    expect(s.rows[2]!.price!).toBeCloseTo(6, 9);
    expect(s.rows[3]!.price!).toBeCloseTo(4, 9);
  });

  it("winter/summer spread = first WIN minus the immediately following SUM", () => {
    const s = gasSeasonality(seasonalStrip("2026-08", 30), null, "2026-07-13");
    expect(s.winterSummerSpread!).toBeCloseTo(2, 9); // 5 − 3
  });

  it("delta1M compares against the same season months on the 1M vintage", () => {
    const latest = seasonalStrip("2026-08", 30);
    const vintage = seasonalStrip("2026-07", 31, -0.5); // older curve, 0.5 lower
    const s = gasSeasonality(latest, vintage, "2026-07-13");
    for (const row of s.rows) expect(row.delta1M!).toBeCloseTo(0.5, 9);
  });

  it("delta1M is null when the vintage is missing", () => {
    const s = gasSeasonality(seasonalStrip("2026-08", 30), null, "2026-07-13");
    for (const row of s.rows) expect(row.delta1M).toBeNull();
  });

  it("rolls to the next winter when the strip starts after November", () => {
    const latest = seasonalStrip("2026-12", 30);
    const s = gasSeasonality(latest, null, "2026-11-30");
    expect(s.rows[0]!.label).toBe("WIN 27/28");
    expect(s.rows[1]!.label).toBe("SUM 28");
  });

  it("season with no months on the curve prices null; spread degrades to null", () => {
    // 5 months Aug–Dec 2026: WIN 26/27 covered only by Nov+Dec, SUM 27 absent.
    const latest = seasonalStrip("2026-08", 5);
    const s = gasSeasonality(latest, null, "2026-07-13");
    expect(s.rows[0]!.price!).toBeCloseTo(5, 9); // partial winter, months present only
    expect(s.rows[1]!.price).toBeNull();
    expect(s.rows[2]!.price).toBeNull();
    expect(s.winterSummerSpread).toBeNull();
  });

  it("empty strip: labels derive from the settle date, all prices null", () => {
    const s = gasSeasonality([], null, "2026-07-13");
    expect(s.rows[0]!.label).toBe("WIN 26/27");
    for (const row of s.rows) expect(row.price).toBeNull();
    expect(s.winterSummerSpread).toBeNull();
  });
});
