import { describe, expect, it } from "vitest";
import type { CurvePoint } from "@/types/commodities";
import { addMonths } from "@/lib/commodities/format";
import { curveStructure } from "@/lib/commodities/structure";

function mk(start: string, prices: number[]): CurvePoint[] {
  return prices.map((price, i) => ({ contractMonth: addMonths(start, i), price }));
}

describe("curveStructure", () => {
  it("backwardated curve: positive front spreads and roll yield", () => {
    // 100, 99, ..., 89 — prompt above the 12th month.
    const latest = mk("2026-08", Array.from({ length: 12 }, (_, i) => 100 - i));
    const s = curveStructure(latest, null);
    expect(s.prompt!).toBeCloseTo(100, 9);
    expect(s.promptMonth).toBe("2026-08");
    expect(s.promptMinus2nd!).toBeCloseTo(1, 9);
    expect(s.promptMinus12th!).toBeCloseTo(11, 9);
    expect(s.backwardated).toBe(true);
    expect(s.rollYield1YPct!).toBeCloseTo(11, 9);
  });

  it("contango curve: backwardated false, negative roll yield", () => {
    const latest = mk("2026-08", Array.from({ length: 12 }, (_, i) => 50 + i));
    const s = curveStructure(latest, null);
    expect(s.backwardated).toBe(false);
    expect(s.promptMinus12th!).toBeCloseTo(-11, 9);
    expect(s.rollYield1YPct!).toBeCloseTo(-22, 9);
  });

  it("strip shorter than 12 months: 12th-month fields degrade to null", () => {
    const s = curveStructure(mk("2026-08", [10, 9, 8]), null);
    expect(s.promptMinus2nd!).toBeCloseTo(1, 9);
    expect(s.promptMinus12th).toBeNull();
    expect(s.backwardated).toBeNull();
    expect(s.rollYield1YPct).toBeNull();
  });

  it("zero prompt: roll yield null (no division by zero)", () => {
    const prices = Array.from({ length: 12 }, (_, i) => -i); // prompt 0
    const s = curveStructure(mk("2026-08", prices), null);
    expect(s.promptMinus12th!).toBeCloseTo(11, 9);
    expect(s.rollYield1YPct).toBeNull();
  });

  it("delta vs 1Y uses the SAME contract month on the vintage when present", () => {
    const latest = mk("2026-08", [100, 99]);
    const vintage = {
      resolvedDate: "2025-07-14",
      points: mk("2025-08", Array.from({ length: 24 }, (_, i) => 90 + i)),
    };
    // Vintage price for 2026-08 (index 12) = 102.
    const s = curveStructure(latest, vintage);
    expect(s.promptDeltaVs1Y!).toBeCloseTo(-2, 9);
    expect(s.vintage1YDate).toBe("2025-07-14");
  });

  it("delta vs 1Y falls back to the vintage's first point when the month is absent", () => {
    const latest = mk("2026-08", [100, 99]);
    const vintage = {
      resolvedDate: "2025-07-14",
      points: mk("2025-08", [95, 94, 93]), // never reaches 2026-08
    };
    const s = curveStructure(latest, vintage);
    expect(s.promptDeltaVs1Y!).toBeCloseTo(5, 9);
  });

  it("null vintage → delta and date null", () => {
    const s = curveStructure(mk("2026-08", [100, 99]), null);
    expect(s.promptDeltaVs1Y).toBeNull();
    expect(s.vintage1YDate).toBeNull();
  });

  it("empty latest strip → everything null", () => {
    const s = curveStructure([], {
      resolvedDate: "2025-07-14",
      points: mk("2025-08", [95]),
    });
    expect(s.prompt).toBeNull();
    expect(s.promptMonth).toBeNull();
    expect(s.promptMinus2nd).toBeNull();
    expect(s.promptMinus12th).toBeNull();
    expect(s.backwardated).toBeNull();
    expect(s.rollYield1YPct).toBeNull();
    expect(s.promptDeltaVs1Y).toBeNull();
    expect(s.vintage1YDate).toBe("2025-07-14"); // passthrough survives
  });
});
