import { describe, expect, it } from "vitest";
import {
  addMonths,
  contractMonthLabel,
  monthDiff,
  monthKeyFromIso,
  shortDate,
} from "@/lib/commodities/format";
import { monthlyAverages } from "@/lib/commodities/history";

describe("format", () => {
  it("monthKeyFromIso truncates to YYYY-MM", () => {
    expect(monthKeyFromIso("2026-08-01")).toBe("2026-08");
    expect(monthKeyFromIso("2026-12-31")).toBe("2026-12");
  });

  it("contractMonthLabel renders M/1/YY without zero padding", () => {
    expect(contractMonthLabel("2026-08")).toBe("8/1/26");
    expect(contractMonthLabel("2027-01")).toBe("1/1/27");
    expect(contractMonthLabel("2026-12")).toBe("12/1/26");
  });

  it("shortDate renders M/D/YY", () => {
    expect(shortDate("2026-07-13")).toBe("7/13/26");
    expect(shortDate("2026-01-05")).toBe("1/5/26");
  });

  it("addMonths handles year rolls in both directions", () => {
    expect(addMonths("2026-08", 1)).toBe("2026-09");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-08", 12)).toBe("2027-08");
    expect(addMonths("2026-08", -20)).toBe("2024-12");
    expect(addMonths("2026-08", 0)).toBe("2026-08");
  });

  it("monthDiff counts whole calendar months, signed", () => {
    expect(monthDiff("2026-08", "2026-10")).toBe(2);
    expect(monthDiff("2026-10", "2026-08")).toBe(-2);
    expect(monthDiff("2026-11", "2027-02")).toBe(3);
    expect(monthDiff("2026-08", "2026-08")).toBe(0);
  });
});

describe("history monthlyAverages", () => {
  it("buckets daily settles into per-month averages, sorted ascending", () => {
    const rows = monthlyAverages([
      { date: "2026-07-02", price: 3.0 },
      { date: "2026-06-30", price: 2.0 },
      { date: "2026-07-01", price: 4.0 },
      { date: "2026-06-29", price: 2.4 },
    ]);
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07"]);
    expect(rows[0]!.avgSettle).toBeCloseTo(2.2, 9);
    expect(rows[1]!.avgSettle).toBeCloseTo(3.5, 9);
  });

  it("skips non-finite prices; empty input yields no months", () => {
    const rows = monthlyAverages([
      { date: "2026-07-01", price: Number.NaN },
      { date: "2026-07-02", price: 3.0 },
      { date: "2026-07-06", price: Number.POSITIVE_INFINITY },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.avgSettle).toBeCloseTo(3.0, 9);
    expect(monthlyAverages([])).toEqual([]);
  });
});
