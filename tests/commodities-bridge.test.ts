import { describe, expect, it } from "vitest";
import { mergeHistoryAndStrip } from "@/lib/commodities/bridge";

describe("mergeHistoryAndStrip", () => {
  const history = [
    { month: "2026-05", avgSettle: 2.8 },
    { month: "2026-06", avgSettle: 2.9 },
    { month: "2026-07", avgSettle: 3.0 },
  ];

  it("splits exactly at the settle month: equal-month history is dropped", () => {
    const strip = [
      { contractMonth: "2026-07", price: 3.1 },
      { contractMonth: "2026-08", price: 3.2 },
    ];
    const out = mergeHistoryAndStrip(history, strip, "2026-07-13");
    expect(out.map((p) => `${p.type}:${p.month}`)).toEqual([
      "HIST:2026-05",
      "HIST:2026-06",
      "FUT:2026-07",
      "FUT:2026-08",
    ]);
    // The seam month carries the futures price, not the partial history avg.
    expect(out[2]!.price).toBeCloseTo(3.1, 9);
  });

  it("drops the settle-month history row even when the strip starts later", () => {
    const strip = [{ contractMonth: "2026-08", price: 3.2 }];
    const out = mergeHistoryAndStrip(history, strip, "2026-07-13");
    expect(out.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-08"]);
    expect(out.map((p) => p.type)).toEqual(["HIST", "HIST", "FUT"]);
  });

  it("sorts unsorted history ascending and maps avgSettle to price", () => {
    const unsorted = [
      { month: "2026-06", avgSettle: 2.9 },
      { month: "2026-04", avgSettle: 2.7 },
      { month: "2026-05", avgSettle: 2.8 },
    ];
    const out = mergeHistoryAndStrip(unsorted, [], "2026-07-13");
    expect(out.map((p) => p.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(out[0]!.price).toBeCloseTo(2.7, 9);
  });

  it("never emits duplicate months across the seam", () => {
    const strip = [
      { contractMonth: "2026-06", price: 3.05 }, // overlaps a pre-settle history month
      { contractMonth: "2026-07", price: 3.1 },
    ];
    const out = mergeHistoryAndStrip(history, strip, "2026-07-13");
    const months = out.map((p) => p.month);
    expect(new Set(months).size).toBe(months.length);
    // The overlapping month is served by the strip.
    expect(out.find((p) => p.month === "2026-06")!.type).toBe("FUT");
  });

  it("empty history → all FUT; empty strip → all HIST", () => {
    const strip = [{ contractMonth: "2026-08", price: 3.2 }];
    expect(mergeHistoryAndStrip([], strip, "2026-07-13")).toEqual([
      { month: "2026-08", price: 3.2, type: "FUT" },
    ]);
    const histOnly = mergeHistoryAndStrip(history, [], "2026-08-03");
    expect(histOnly.map((p) => p.type)).toEqual(["HIST", "HIST", "HIST"]);
  });
});
