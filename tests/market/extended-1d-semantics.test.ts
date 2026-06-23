/**
 * Tests for trade-date anchoring, stale-DB guards, and AH-only 1D semantics.
 */
import { describe, it, expect } from "vitest";
import {
  applyExtendedQuoteOverlay,
  computeAhOnly1DReturn,
} from "../../src/server/services/market-map.service";
import type { ExtendedTickerQuote } from "../../src/server/services/extended-hours.service";
import type { DateClose } from "../../src/domain/calculations/alignment";
import { securityHorizonMetrics } from "../../src/domain/calculations/security-metrics";

function quote(
  partial: Partial<ExtendedTickerQuote> & Pick<ExtendedTickerQuote, "price" | "tradeDateEt">,
): ExtendedTickerQuote {
  return {
    session: "POST",
    asOfUnix: 0,
    regularClose: null,
    ...partial,
  };
}

describe("applyExtendedQuoteOverlay — tradeDateEt anchoring", () => {
  it("replaces the bar on tradeDateEt instead of wall-clock today", () => {
    const series: DateClose[] = [
      { date: "2026-06-20", adjClose: 90 },
      { date: "2026-06-22", adjClose: 80.88 },
    ];
    const q = quote({
      price: 81.5,
      tradeDateEt: "2026-06-22",
      regularClose: 80.88,
    });
    const r = applyExtendedQuoteOverlay(series, q);
    expect(r.applied).toBe(true);
    expect(r.series).toHaveLength(2);
    expect(r.series[1]).toEqual({ date: "2026-06-22", adjClose: 81.5 });
  });

  it("appends on tradeDateEt when the DB ends the prior day", () => {
    const series: DateClose[] = [
      { date: "2026-06-19", adjClose: 90 },
      { date: "2026-06-20", adjClose: 85 },
    ];
    const q = quote({
      price: 209.6,
      tradeDateEt: "2026-06-22",
      regularClose: 209.83,
    });
    const r = applyExtendedQuoteOverlay(series, q);
    expect(r.applied).toBe(true);
    expect(r.series[r.series.length - 1]).toEqual({
      date: "2026-06-22",
      adjClose: 209.6,
    });
  });

  it("skips overlay when DB lags print date by more than one trading day", () => {
    const series: DateClose[] = [
      { date: "2026-06-15", adjClose: 90 },
      { date: "2026-06-18", adjClose: 85 },
    ];
    const q = quote({
      price: 89.5,
      tradeDateEt: "2026-06-22",
      regularClose: 80.88,
    });
    const r = applyExtendedQuoteOverlay(series, q);
    expect(r.applied).toBe(false);
    expect(r.skipReason).toBe("stale_db");
    expect(r.series).toBe(series);
  });
});

describe("computeAhOnly1DReturn — CAVA / GLW / PRIM semantics", () => {
  it("CAVA: AH 81.50 vs regular close 80.88 ≈ +0.77%", () => {
    const q = quote({
      price: 81.5,
      tradeDateEt: "2026-06-22",
      regularClose: 80.88,
    });
    const d1 = computeAhOnly1DReturn(q, 80.88);
    expect(d1).toBeCloseTo(81.5 / 80.88 - 1, 12);
    expect(d1!).toBeCloseTo(0.00766, 4);
  });

  it("GLW: AH 209.60 vs regular close 209.83 ≈ -0.11%", () => {
    const q = quote({
      price: 209.6,
      tradeDateEt: "2026-06-22",
      regularClose: 209.83,
    });
    const d1 = computeAhOnly1DReturn(q, 209.83);
    expect(d1).toBeCloseTo(209.6 / 209.83 - 1, 12);
    expect(d1!).toBeCloseTo(-0.0011, 3);
  });

  it("PRIM: AH 73.89 vs regular close 108.34 ≈ -31.8%", () => {
    const q = quote({
      price: 73.89,
      tradeDateEt: "2026-06-22",
      regularClose: 108.34,
    });
    const d1 = computeAhOnly1DReturn(q, 108.34);
    expect(d1).toBeCloseTo(73.89 / 108.34 - 1, 12);
    expect(d1!).toBeCloseTo(-0.318, 2);
  });

  it("rejects wrong price 89.5 vs regular close 80.88 (not +10.66%)", () => {
    const q = quote({
      price: 89.5,
      tradeDateEt: "2026-06-22",
      regularClose: 80.88,
    });
    const wrongChain1D = 89.5 / 80.88 - 1;
    expect(wrongChain1D).toBeCloseTo(0.1066, 3);
    const correctAh1D = computeAhOnly1DReturn(
      quote({ price: 81.5, tradeDateEt: "2026-06-22", regularClose: 80.88 }),
      80.88,
    );
    expect(correctAh1D).not.toBeCloseTo(wrongChain1D, 2);
  });
});

describe("AH-only 1D override vs longer horizons", () => {
  it("overrides D1 but keeps 5D telescoping on the extended endpoint", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const series: DateClose[] = closes.map((c, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      adjClose: c,
    }));
    const q = quote({
      price: 120,
      tradeDateEt: "2026-06-10",
      regularClose: 109,
    });
    const { series: overlaid, ahOnly1D } = applyExtendedQuoteOverlay(series, q);
    expect(ahOnly1D).toBeCloseTo(120 / 109 - 1, 12);

    const metrics = securityHorizonMetrics(overlaid, null, 0);
    metrics.D1.return = ahOnly1D!;
    expect(metrics.D1.return).toBeCloseTo(120 / 109 - 1, 12);
    expect(metrics.D5.return).toBeCloseTo(120 / 104 - 1, 12);
  });
});
