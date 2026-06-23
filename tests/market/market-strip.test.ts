/**
 * Pure tests for the market-strip computeStripQuote helper.
 *
 * Covers the change / changePct / changeBp derivations plus the null/guard
 * branches that let the UI render a dash without per-field branching.
 */
import { describe, it, expect } from "vitest";
import { computeStripQuote } from "../../src/server/services/market-strip.service";

describe("computeStripQuote", () => {
  it("computes change and changePct for a price instrument", () => {
    const r = computeStripQuote(105, 100, "price");
    expect(r.change).toBeCloseTo(5, 12);
    expect(r.changePct).toBeCloseTo(0.05, 12);
    expect(r.changeBp).toBeNull();
  });

  it("handles a negative move with signed values intact", () => {
    const r = computeStripQuote(98, 100, "price");
    expect(r.change).toBeCloseTo(-2, 12);
    expect(r.changePct).toBeCloseTo(-0.02, 12);
  });

  it("converts yield-point change to basis points (1 yp = 100 bp)", () => {
    // 10y yield moves from 4.20% to 4.32% -> +0.12 yp -> +12.0 bp
    const r = computeStripQuote(4.32, 4.20, "yield");
    expect(r.change).toBeCloseTo(0.12, 12);
    expect(r.changeBp).toBeCloseTo(12, 10);
    expect(r.changePct).toBeCloseTo(0.12 / 4.2, 12);
  });

  it("returns null fields when price is missing", () => {
    expect(computeStripQuote(null, 100, "price")).toEqual({
      change: null,
      changePct: null,
      changeBp: null,
    });
    expect(computeStripQuote(undefined, 100, "price")).toEqual({
      change: null,
      changePct: null,
      changeBp: null,
    });
  });

  it("returns null fields when prevClose is missing", () => {
    expect(computeStripQuote(100, null, "price")).toEqual({
      change: null,
      changePct: null,
      changeBp: null,
    });
  });

  it("returns null changePct when prevClose is zero (no division-by-zero leak)", () => {
    const r = computeStripQuote(5, 0, "yield");
    expect(r.change).toBeCloseTo(5, 12);
    expect(r.changePct).toBeNull();
    expect(r.changeBp).toBeCloseTo(500, 10);
  });

  it("rejects non-finite numbers (NaN, Infinity) as missing", () => {
    expect(computeStripQuote(NaN, 100, "price").change).toBeNull();
    expect(computeStripQuote(100, NaN, "price").change).toBeNull();
    expect(computeStripQuote(Infinity, 100, "price").change).toBeNull();
  });
});
