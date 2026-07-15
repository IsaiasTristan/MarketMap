import { describe, expect, it } from "vitest";
import type { CurvePoint } from "@/types/commodities";
import { addMonths } from "@/lib/commodities/format";
import {
  balStrip,
  calStrip,
  rollingStrip,
  stripAvgByIndex,
  stripDelta,
} from "@/lib/commodities/strips";
import { TENOR_DEFS, tenorColumns, tenorValues } from "@/lib/commodities/tenors";

function mk(start: string, prices: number[]): CurvePoint[] {
  return prices.map((price, i) => ({ contractMonth: addMonths(start, i), price }));
}

describe("stripAvgByIndex", () => {
  it("averages the index slice", () => {
    const p = mk("2026-08", [10, 20, 30, 40]);
    expect(stripAvgByIndex(p, 0, 2)).toBeCloseTo(15, 9);
    expect(stripAvgByIndex(p, 1, 4)).toBeCloseTo(30, 9);
  });

  it("null on an empty slice", () => {
    const p = mk("2026-08", [10, 20]);
    expect(stripAvgByIndex(p, 2, 5)).toBeNull();
    expect(stripAvgByIndex([], 0, 12)).toBeNull();
  });
});

describe("balStrip", () => {
  it("averages the remaining current-year months", () => {
    // Settle in July 2026, strip starts Aug: BAL-26 = Aug..Dec 2026.
    const p = mk("2026-08", [10, 20, 30, 40, 50, 60, 70]);
    const r = balStrip(p, "2026-07-13");
    expect(r.label).toBe("BAL-26");
    expect(r.avg!).toBeCloseTo(30, 9); // (10+20+30+40+50)/5
  });

  it("December edge: no current-year months remain → null (label kept)", () => {
    const p = mk("2027-01", [10, 20, 30]);
    const r = balStrip(p, "2026-12-14");
    expect(r.label).toBe("BAL-26");
    expect(r.avg).toBeNull();
  });

  it("empty strip → null", () => {
    expect(balStrip([], "2026-07-13").avg).toBeNull();
  });
});

describe("calStrip", () => {
  it("averages the months of the year present in the strip (partial coverage ok)", () => {
    // 2026-08 start, 12 points → 2027 coverage is Jan..Jul only.
    const p = mk("2026-08", [1, 1, 1, 1, 1, 10, 20, 30, 40, 50, 60, 70]);
    const r = calStrip(p, 2027);
    expect(r.label).toBe("CAL-27");
    expect(r.avg!).toBeCloseTo(40, 9); // avg of the seven 2027 months
  });

  it("null when the year has no months in the strip", () => {
    const p = mk("2026-08", [1, 2, 3]);
    const r = calStrip(p, 2030);
    expect(r.label).toBe("CAL-30");
    expect(r.avg).toBeNull();
  });
});

describe("rollingStrip", () => {
  it("averages the first N points when the strip is long enough", () => {
    const p = mk("2026-08", Array.from({ length: 15 }, (_, i) => i + 1));
    const r = rollingStrip(p, 12);
    expect(r.covered).toBe(12);
    expect(r.avg!).toBeCloseTo(6.5, 9); // avg 1..12
  });

  it("short strip: averages what exists and reports covered", () => {
    const p = mk("2026-08", Array.from({ length: 15 }, (_, i) => i + 1));
    const r = rollingStrip(p, 36);
    expect(r.covered).toBe(15);
    expect(r.avg!).toBeCloseTo(8, 9); // avg 1..15
  });

  it("empty strip → avg null, covered 0", () => {
    const r = rollingStrip([], 60);
    expect(r.avg).toBeNull();
    expect(r.covered).toBe(0);
  });
});

describe("stripDelta", () => {
  it("abs and pct vs prior", () => {
    const d = stripDelta(11, 10);
    expect(d.abs!).toBeCloseTo(1, 9);
    expect(d.pct!).toBeCloseTo(10, 9);
  });

  it("pct uses |prior| for negative priors", () => {
    const d = stripDelta(-9, -10);
    expect(d.abs!).toBeCloseTo(1, 9);
    expect(d.pct!).toBeCloseTo(10, 9);
  });

  it("pct null when prior is 0 (abs still computed)", () => {
    const d = stripDelta(5, 0);
    expect(d.abs!).toBeCloseTo(5, 9);
    expect(d.pct).toBeNull();
  });

  it("both null when either side is null", () => {
    expect(stripDelta(null, 10)).toEqual({ abs: null, pct: null });
    expect(stripDelta(10, null)).toEqual({ abs: null, pct: null });
  });
});

describe("tenors", () => {
  it("TENOR_DEFS point at indexes 0/2/5/11/23/35/59", () => {
    expect(TENOR_DEFS.map((d) => d.index)).toEqual([0, 2, 5, 11, 23, 35, 59]);
  });

  it("tenorColumns: point tenors carry contract months, strips carry null", () => {
    const p = mk("2026-08", Array.from({ length: 60 }, (_, i) => i + 1));
    const cols = tenorColumns(p);
    expect(cols.map((c) => c.label)).toEqual([
      "1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "12M AVG", "36M AVG", "60M AVG",
    ]);
    expect(cols[0]!.contractMonth).toBe("2026-08");
    expect(cols[3]!.contractMonth).toBe("2027-07"); // index 11
    expect(cols[6]!.contractMonth).toBe("2031-07"); // index 59
    expect(cols[7]!.contractMonth).toBeNull();
  });

  it("tenorColumns: short strip yields null contract months beyond its length", () => {
    const cols = tenorColumns(mk("2026-08", Array.from({ length: 29 }, () => 1)));
    expect(cols[4]!.contractMonth).toBe("2028-07"); // 2Y, index 23 exists
    expect(cols[5]!.contractMonth).toBeNull(); // 3Y, index 35 missing
    expect(cols[6]!.contractMonth).toBeNull(); // 5Y
  });

  it("tenorValues: point prices then rolling averages, nulls beyond the strip", () => {
    const p = mk("2026-08", Array.from({ length: 29 }, (_, i) => i + 1));
    const v = tenorValues(p);
    expect(v[0]!).toBeCloseTo(1, 9);
    expect(v[3]!).toBeCloseTo(12, 9); // index 11
    expect(v[4]!).toBeCloseTo(24, 9); // index 23
    expect(v[5]).toBeNull(); // index 35 beyond 29 points
    expect(v[6]).toBeNull(); // index 59
    expect(v[7]!).toBeCloseTo(6.5, 9); // 12M AVG of 1..12
    expect(v[8]!).toBeCloseTo(15, 9); // 36M AVG over 29 covered (1..29)
    expect(v[9]!).toBeCloseTo(15, 9); // 60M AVG over 29 covered
  });
});
