import { describe, expect, it } from "vitest";
import { toOutright } from "@/lib/commodities/outright";

describe("toOutright", () => {
  it("adds basis to bench on matching contract months", () => {
    const basis = [
      { contractMonth: "2026-08", price: -0.5 },
      { contractMonth: "2026-09", price: -0.4 },
    ];
    const bench = [
      { contractMonth: "2026-08", price: 3.0 },
      { contractMonth: "2026-09", price: 3.2 },
    ];
    const out = toOutright(basis, bench);
    expect(out).toHaveLength(2);
    expect(out[0]!.contractMonth).toBe("2026-08");
    expect(out[0]!.price).toBeCloseTo(2.5, 9);
    expect(out[1]!.price).toBeCloseTo(2.8, 9);
  });

  it("drops basis months missing from the bench (no null prices emitted)", () => {
    const basis = [
      { contractMonth: "2026-08", price: -0.5 },
      { contractMonth: "2026-09", price: -0.4 },
      { contractMonth: "2026-10", price: -0.3 },
    ];
    const bench = [
      { contractMonth: "2026-08", price: 3.0 },
      { contractMonth: "2026-10", price: 3.4 },
    ];
    const out = toOutright(basis, bench);
    expect(out.map((p) => p.contractMonth)).toEqual(["2026-08", "2026-10"]);
    expect(out[1]!.price).toBeCloseTo(3.1, 9);
  });

  it("ignores extra bench months not present in the basis strip", () => {
    const basis = [{ contractMonth: "2026-09", price: 0.1 }];
    const bench = [
      { contractMonth: "2026-08", price: 3.0 },
      { contractMonth: "2026-09", price: 3.2 },
      { contractMonth: "2026-10", price: 3.4 },
    ];
    const out = toOutright(basis, bench);
    expect(out).toHaveLength(1);
    expect(out[0]!.contractMonth).toBe("2026-09");
    expect(out[0]!.price).toBeCloseTo(3.3, 9);
  });

  it("empty inputs produce an empty outright strip", () => {
    expect(toOutright([], [{ contractMonth: "2026-08", price: 3 }])).toEqual([]);
    expect(toOutright([{ contractMonth: "2026-08", price: 1 }], [])).toEqual([]);
  });
});
