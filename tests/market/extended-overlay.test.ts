/**
 * Pure tests for `applyExtendedOverlay` (legacy) + `applyExtendedQuoteOverlay`.
 */
import { describe, it, expect } from "vitest";
import {
  applyExtendedOverlay,
  applyExtendedQuoteOverlay,
} from "../../src/server/services/market-map.service";
import type { DateClose } from "../../src/domain/calculations/alignment";
import { securityHorizonMetrics } from "../../src/domain/calculations/security-metrics";

function makeSeries(closes: number[], startIso = "2026-06-01"): DateClose[] {
  const start = new Date(`${startIso}T00:00:00Z`);
  return closes.map((c, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    return { date: d.toISOString().slice(0, 10), adjClose: c };
  });
}

describe("applyExtendedOverlay", () => {
  it("appends a new bar when the last bar predates today", () => {
    const s = makeSeries([100, 101, 102]); // last date = 2026-06-03
    const out = applyExtendedOverlay(s, 105, "2026-06-04");
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({ date: "2026-06-04", adjClose: 105 });
    // Prior bars untouched (immutability).
    expect(out.slice(0, 3)).toEqual(s);
  });

  it("replaces the last bar when its date matches today", () => {
    const s = makeSeries([100, 101, 102]); // last date = 2026-06-03
    const out = applyExtendedOverlay(s, 109, "2026-06-03");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ date: "2026-06-03", adjClose: 109 });
    // First two bars untouched.
    expect(out[0]).toEqual(s[0]);
    expect(out[1]).toEqual(s[1]);
  });

  it("returns the series unchanged when last.date is past today", () => {
    const s = makeSeries([100, 101, 102]); // last date = 2026-06-03
    const out = applyExtendedOverlay(s, 999, "2026-05-30");
    expect(out).toBe(s);
  });

  it("no-ops on an empty series", () => {
    const out = applyExtendedOverlay([], 100, "2026-06-04");
    expect(out).toEqual([]);
  });

  it("no-ops when price is non-finite (NaN / Infinity)", () => {
    const s = makeSeries([100, 101, 102]);
    expect(applyExtendedOverlay(s, NaN, "2026-06-04")).toBe(s);
    expect(applyExtendedOverlay(s, Infinity, "2026-06-04")).toBe(s);
  });
});

describe("applyExtendedQuoteOverlay — horizon return integration", () => {
  it("recomputes 5D against the extended endpoint on tradeDateEt", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const s = makeSeries(closes);
    const last = s[s.length - 1]!.date;
    const r = applyExtendedQuoteOverlay(s, {
      price: 120,
      session: "POST",
      asOfUnix: 0,
      tradeDateEt: last,
      regularClose: 109,
    });
    expect(r.applied).toBe(true);
    expect(r.ahOnly1D).toBeCloseTo(120 / 109 - 1, 12);
    const metrics = securityHorizonMetrics(r.series, null, 0);
    expect(metrics.D5.return).toBeCloseTo(120 / 104 - 1, 12);
  });
});

describe("applyExtendedOverlay — legacy helper", () => {
  it("recomputes 1D against the prior-day close after appending", () => {
    // Need >= 3 bars for securityHorizonMetrics. Build a long enough chain
    // and add an extended overlay on top.
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i); // 100..109
    const s = makeSeries(closes);
    const overlaid = applyExtendedOverlay(s, 120, "2026-06-11");

    // 1D return should be 120 / 109 - 1 (last bar vs prior close).
    const metrics = securityHorizonMetrics(overlaid, null, 0);
    expect(metrics.D1.return).toBeCloseTo(120 / 109 - 1, 12);
  });

  it("recomputes the multi-day horizon endpoint against the extended price", () => {
    // 30-bar series 100..129, replace the last bar's close with 200.
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const s = makeSeries(closes);
    const last = s[s.length - 1]!.date;
    const overlaid = applyExtendedOverlay(s, 200, last);

    // 5D total return telescopes the last 5 daily returns:
    //   Π_{i=1..5}(closes[n-5+i] / closes[n-5+i-1]) - 1
    //   = closes[n-1] / closes[n-1-5] - 1
    // n = 30 closes after overlay; closes[24] = 124, closes[29] = 200.
    const metrics = securityHorizonMetrics(overlaid, null, 0);
    const expected = 200 / 124 - 1;
    expect(metrics.D5.return).toBeCloseTo(expected, 12);
  });
});
