import { describe, expect, it } from "vitest";
import {
  detectInitiations,
  sizingMult,
  type BookPosition,
  INITIATION_CONFIG as CFG,
} from "@/domain/calculations/initiation";

/** Build an N-position book at a target median, with one optional NEW entry. */
function book(medianPct: number, count: number, entry?: { pct: number; isNew: boolean }): BookPosition[] {
  const positions: BookPosition[] = [];
  for (let i = 0; i < count; i++) positions.push({ ticker: `H${i}`, pctOfBook: medianPct, isNew: false });
  if (entry) positions.push({ ticker: "ENTRY", pctOfBook: entry.pct, isNew: entry.isNew });
  return positions;
}

describe("initiation: sizing math (Part 1b)", () => {
  // t2 — a one-stock fund entering at 100% of book: it IS its own median, so
  // sizing_mult 1.0, strength 1.0. Concentration alone is not conviction.
  it("t2: entering at the book's median size ⇒ sizing_mult 1.0", () => {
    expect(sizingMult(100, [100])).toBe(1);
    expect(sizingMult(2, [1, 2, 3])).toBe(1); // median 2, entry 2
  });

  it("sizing_mult scales linearly above/below the median", () => {
    expect(sizingMult(5, [1, 1, 1, 1.1])).toBeCloseTo(5 / 1, 4); // median 1
    expect(sizingMult(0.5, [1, 2, 3])).toBe(0.25); // median 2
  });

  it("returns 0 when the median book weight is 0", () => {
    expect(sizingMult(5, [])).toBe(0);
    expect(sizingMult(5, [0, 0])).toBe(0);
  });
});

describe("initiation: detectInitiations qualification + strength", () => {
  // t3 — a 40-position fund initiating at 5% vs a 1.1% median ⇒ sizing_mult
  // ~4.5, capped strength 4.0.
  it("t3: 40-position fund at 5% vs 1.1% median ⇒ strength capped at 4.0", () => {
    const positions: BookPosition[] = [];
    for (let i = 0; i < 39; i++) positions.push({ ticker: `H${i}`, pctOfBook: 1.1, isNew: false });
    positions.push({ ticker: "BIG", pctOfBook: 5, isNew: true });
    const out = detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("BIG");
    expect(out[0]!.sizingMult).toBeCloseTo(5 / 1.1, 2);
    expect(out[0]!.strength).toBe(CFG.strength_cap); // 4.0
    expect(out[0]!.entryBps).toBe(500);
  });

  // t4 — a fund's first-ever 13F emits zero initiations (no prior baseline).
  it("t4: new filer's first 13F ⇒ zero initiations", () => {
    const positions = book(2, 10, { pct: 8, isNew: true });
    expect(detectInitiations({ positions, isFirstFiling: true, quartersSincePrevFiling: null })).toEqual([]);
  });

  it("first filing after a > 2-quarter gap emits none", () => {
    const positions = book(2, 10, { pct: 8, isNew: true });
    expect(detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 3 })).toEqual([]);
  });

  it("a filing with fewer than min_positions (8) emits none regardless", () => {
    const positions = book(2, 6, { pct: 30, isNew: true }); // 7 positions total
    expect(detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 1 })).toEqual([]);
  });

  it("entry below min_entry_bps (25 = 0.25%) does not qualify", () => {
    const positions = book(0.1, 12, { pct: 0.2, isNew: true }); // entry 20 bps < 25
    expect(detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 1 })).toEqual([]);
  });

  it("entry below min_sizing_mult (0.5× median) does not qualify", () => {
    const positions = book(4, 12, { pct: 1, isNew: true }); // sizing 0.25 < 0.5
    expect(detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 1 })).toEqual([]);
  });

  it("only NEW positions are considered", () => {
    const positions = book(1, 12, { pct: 5, isNew: false });
    expect(detectInitiations({ positions, isFirstFiling: false, quartersSincePrevFiling: 1 })).toEqual([]);
  });
});
