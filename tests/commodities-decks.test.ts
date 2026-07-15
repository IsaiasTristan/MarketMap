import { describe, expect, it } from "vitest";
import type { CurvePoint, PriceDeckDto } from "@/types/commodities";
import { addMonths } from "@/lib/commodities/format";
import { expandDeck } from "@/lib/commodities/decks";

function mk(start: string, prices: number[]): CurvePoint[] {
  return prices.map((price, i) => ({ contractMonth: addMonths(start, i), price }));
}

function mkDeck(over: Partial<PriceDeckDto> = {}): PriceDeckDto {
  return {
    id: "d1",
    name: "Test deck",
    stripMonths: 2,
    terminalRule: "FLAT",
    terminalValueOil: null,
    terminalValueGas: null,
    terminalValueNgl: null,
    escalationPctPerYear: null,
    haircutPct: null,
    horizonMonths: 5,
    ...over,
  };
}

const OUTRIGHT = { kind: "FLAT" as const, group: "GAS" as const };

describe("expandDeck guards", () => {
  it("rejects a basis curve in diff mode", () => {
    const r = expandDeck(
      mkDeck(),
      mk("2026-08", [1]),
      { kind: "BASIS", group: "GAS" },
      true,
    );
    expect(r).toEqual({ ok: false, reason: "BASIS_NOT_ALLOWED" });
  });

  it("allows a basis curve when viewed as outright (diff mode off)", () => {
    const r = expandDeck(
      mkDeck({ terminalValueGas: 3 }),
      mk("2026-08", [1, 2]),
      { kind: "BASIS", group: "GAS" },
      false,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an empty strip", () => {
    expect(expandDeck(mkDeck(), [], OUTRIGHT, false)).toEqual({
      ok: false,
      reason: "NO_STRIP",
    });
  });

  it("FLAT with a null terminal value for the group fails", () => {
    const r = expandDeck(
      mkDeck({ terminalValueOil: 70 }), // GAS group → gas value is what matters
      mk("2026-08", [1, 2]),
      OUTRIGHT,
      false,
    );
    expect(r).toEqual({ ok: false, reason: "NO_TERMINAL_VALUE" });
  });

  it("FLAT with a null terminal value succeeds when the horizon never reaches terminal", () => {
    const r = expandDeck(
      mkDeck({ stripMonths: 6, horizonMonths: 4 }),
      mk("2026-08", [10, 20, 30]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Strip extended flat at the last price past its actual length.
      expect(r.months.map((m) => m.price)).toEqual([10, 20, 30, 30]);
    }
  });
});

describe("expandDeck paths", () => {
  it("FLAT: strip prices then the group's terminal value; month keys continue from the front", () => {
    const r = expandDeck(
      mkDeck({ terminalValueGas: 3.5 }),
      mk("2026-08", [10, 20, 30]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months).toHaveLength(5);
      expect(r.months.map((m) => m.month)).toEqual([
        "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
      ]);
      expect(r.months.map((m) => m.price)).toEqual([10, 20, 3.5, 3.5, 3.5]);
    }
  });

  it("picks the terminal value by commodity group", () => {
    const deck = mkDeck({
      terminalValueOil: 70,
      terminalValueGas: 3.5,
      terminalValueNgl: 25,
    });
    const strip = mk("2026-08", [1, 2]);
    const oil = expandDeck(deck, strip, { kind: "FLAT", group: "OIL" }, false);
    const ngl = expandDeck(deck, strip, { kind: "FLAT", group: "NGL" }, false);
    if (oil.ok) expect(oil.months[2]!.price).toBeCloseTo(70, 9);
    if (ngl.ok) expect(ngl.months[2]!.price).toBeCloseTo(25, 9);
    expect(oil.ok && ngl.ok).toBe(true);
  });

  it("STRIP_AVG: terminal holds the average of the strip-period prices", () => {
    const r = expandDeck(
      mkDeck({ terminalRule: "STRIP_AVG" }),
      mk("2026-08", [10, 20, 999]), // 3rd strip point outside the 2-month window
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months.map((m) => m.price)).toEqual([10, 20, 15, 15, 15]);
    }
  });

  it("ESCALATE: strip-average base escalated once per whole year past terminal start", () => {
    const r = expandDeck(
      mkDeck({ terminalRule: "ESCALATE", escalationPctPerYear: 10, horizonMonths: 16 }),
      mk("2026-08", [10, 20]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months[2]!.price).toBeCloseTo(15, 9); // year 0
      expect(r.months[13]!.price).toBeCloseTo(15, 9); // still year 0 (11 months in)
      expect(r.months[14]!.price).toBeCloseTo(16.5, 9); // year 1: 15 × 1.1
      expect(r.months[15]!.price).toBeCloseTo(16.5, 9);
    }
  });

  it("ESCALATE with null escalation behaves as 0% (flat strip average)", () => {
    const r = expandDeck(
      mkDeck({ terminalRule: "ESCALATE", escalationPctPerYear: null, horizonMonths: 16 }),
      mk("2026-08", [10, 20]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.months[15]!.price).toBeCloseTo(15, 9);
  });

  it("haircut applies to the strip portion and flows into the STRIP_AVG terminal base", () => {
    const r = expandDeck(
      mkDeck({ terminalRule: "STRIP_AVG", haircutPct: 5 }),
      mk("2026-08", [10, 20]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months[0]!.price).toBeCloseTo(9.5, 9);
      expect(r.months[1]!.price).toBeCloseTo(19, 9);
      expect(r.months[2]!.price).toBeCloseTo(14.25, 9); // avg of haircut strip
    }
  });

  it("haircut does not touch a FLAT terminal value", () => {
    const r = expandDeck(
      mkDeck({ terminalValueGas: 3.5, haircutPct: 10 }),
      mk("2026-08", [10, 20]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months[0]!.price).toBeCloseTo(9, 9);
      expect(r.months[2]!.price).toBeCloseTo(3.5, 9);
    }
  });

  it("defaults the horizon to 360 months when unset (0)", () => {
    const r = expandDeck(
      mkDeck({ terminalRule: "STRIP_AVG", horizonMonths: 0 }),
      mk("2026-08", [10, 20]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months).toHaveLength(360);
      expect(r.months[359]!.month).toBe("2056-07");
    }
  });
});

describe("TRAILING_STRIP_AVG terminal rule", () => {
  it("60-month window: terminal = average of the final 12 strip months", () => {
    // Prices 1..60 → trailing 12 = months 49..60 (values 49..60), avg 54.5.
    const prices = Array.from({ length: 60 }, (_, i) => i + 1);
    const r = expandDeck(
      mkDeck({ stripMonths: 60, terminalRule: "TRAILING_STRIP_AVG", horizonMonths: 72 }),
      mk("2026-08", prices),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months[59]!.price).toBeCloseTo(60, 9); // last strip month
      expect(r.months[60]!.price).toBeCloseTo(54.5, 9); // terminal starts
      expect(r.months[71]!.price).toBeCloseTo(54.5, 9); // stays flat
    }
  });

  it("windows shorter than 12 average the whole window", () => {
    const r = expandDeck(
      mkDeck({ stripMonths: 3, terminalRule: "TRAILING_STRIP_AVG", horizonMonths: 6 }),
      mk("2026-08", [10, 20, 30]),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.months[3]!.price).toBeCloseTo(20, 9);
  });

  it("haircut flows into the trailing average", () => {
    const prices = Array.from({ length: 24 }, () => 100);
    const r = expandDeck(
      mkDeck({ stripMonths: 24, terminalRule: "TRAILING_STRIP_AVG", haircutPct: 5, horizonMonths: 30 }),
      mk("2026-08", prices),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.months[24]!.price).toBeCloseTo(95, 9);
  });

  it("deck window padded past a short strip uses the padded trailing months", () => {
    // 20-real-month strip, 24-month window → months 21-24 pad at the last
    // price (20); trailing 12 = window months 13..24 = [13..20, 20,20,20,20].
    const prices = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = expandDeck(
      mkDeck({ stripMonths: 24, terminalRule: "TRAILING_STRIP_AVG", horizonMonths: 26 }),
      mk("2026-08", prices),
      OUTRIGHT,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const expected = ([13, 14, 15, 16, 17, 18, 19, 20, 20, 20, 20, 20].reduce((a, b) => a + b, 0)) / 12;
      expect(r.months[24]!.price).toBeCloseTo(expected, 9);
    }
  });
});
