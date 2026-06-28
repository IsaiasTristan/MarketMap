import { describe, expect, it } from "vitest";
import {
  residual,
  returnSinceIndex,
  trailingWindowReturn,
  indexAtOrBefore,
  returnBetween,
} from "@/lib/fundamental/residual-momentum";

describe("trailingWindowReturn", () => {
  it("computes the return over a trailing [fromBack, toBack] window", () => {
    // 10 closes: index 0..9. fromBack=6 -> idx 4, toBack=2 -> idx 8.
    const closes = [10, 11, 12, 13, 100, 16, 17, 18, 200, 21];
    // 200/100 - 1 = 1.0
    expect(trailingWindowReturn(closes, 6, 2)!).toBeCloseTo(1.0, 9);
  });
  it("returns null when the window is out of range or fromBack <= toBack", () => {
    expect(trailingWindowReturn([1, 2, 3], 6, 2)).toBeNull();
    expect(trailingWindowReturn([1, 2, 3, 4, 5], 2, 2)).toBeNull();
  });
  it("returns null on a non-positive boundary price", () => {
    const closes = [0, 11, 12, 13, 14, 15, 16, 17];
    expect(trailingWindowReturn(closes, 8, 1)).toBeNull();
  });
});

describe("returnSinceIndex", () => {
  it("computes the return from an index to the last close", () => {
    const closes = [50, 55, 60, 66];
    expect(returnSinceIndex(closes, 0)!).toBeCloseTo(66 / 50 - 1, 9);
  });
  it("returns null for an out-of-range index", () => {
    expect(returnSinceIndex([1, 2], 5)).toBeNull();
  });
});

describe("indexAtOrBefore", () => {
  const dates = ["2026-01-02", "2026-01-05", "2026-01-08", "2026-01-12"];
  it("finds the last date on or before the target", () => {
    expect(indexAtOrBefore(dates, "2026-01-08")).toBe(2); // exact match
    expect(indexAtOrBefore(dates, "2026-01-10")).toBe(2); // between -> prior
    expect(indexAtOrBefore(dates, "2026-02-01")).toBe(3); // after end -> last
  });
  it("returns -1 when the target precedes the whole series", () => {
    expect(indexAtOrBefore(dates, "2025-12-31")).toBe(-1);
  });
});

describe("returnBetween", () => {
  it("computes the return from the close on/just-before a date to the last close", () => {
    const dates = ["2026-01-02", "2026-01-05", "2026-01-08", "2026-01-12"];
    const closes = [100, 110, 120, 132];
    // earnings on 2026-01-06 (no bar) -> anchor to 2026-01-05 close (110): 132/110-1.
    expect(returnBetween(dates, closes, "2026-01-06")!).toBeCloseTo(132 / 110 - 1, 9);
  });
  it("returns null when the date precedes the series", () => {
    expect(returnBetween(["2026-01-05"], [100], "2026-01-01")).toBeNull();
  });
});

describe("residual", () => {
  it("subtracts the benchmark from the stock return", () => {
    expect(residual(0.2, 0.05)!).toBeCloseTo(0.15, 9);
  });
  it("returns null when either return is missing", () => {
    expect(residual(null, 0.1)).toBeNull();
    expect(residual(0.1, null)).toBeNull();
  });
});
