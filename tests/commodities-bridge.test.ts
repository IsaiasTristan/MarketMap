import { describe, expect, it } from "vitest";
import { mergeHistoryAndStrip } from "@/lib/commodities/bridge";

describe("mergeHistoryAndStrip", () => {
  const history = [
    { month: "2026-05", avgSettle: 2.8 },
    { month: "2026-06", avgSettle: 2.9 },
    { month: "2026-07", avgSettle: 3.0 },
  ];

  it("seam sits at the strip's first month: colliding history is dropped", () => {
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

  it("KEEPS the settle-month realized row when the prompt has rolled past it", () => {
    // WTI case: settle 7/13/26, strip starts 2026-08 — the realized July
    // settle belongs in history (this was the missing prompt-month bug).
    const strip = [{ contractMonth: "2026-08", price: 3.2 }];
    const out = mergeHistoryAndStrip(history, strip, "2026-07-13");
    expect(out.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(out.map((p) => p.type)).toEqual(["HIST", "HIST", "HIST", "FUT"]);
    expect(out[2]!.price).toBeCloseTo(3.0, 9);
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
      { contractMonth: "2026-06", price: 3.05 }, // overlaps a history month
      { contractMonth: "2026-07", price: 3.1 },
    ];
    const out = mergeHistoryAndStrip(history, strip, "2026-07-13");
    const months = out.map((p) => p.month);
    expect(new Set(months).size).toBe(months.length);
    // The overlapping months are served by the strip (BRN-style current-month
    // prompt), and no history may leak past the strip start.
    expect(out.find((p) => p.month === "2026-06")!.type).toBe("FUT");
    expect(out.find((p) => p.month === "2026-07")!.type).toBe("FUT");
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
