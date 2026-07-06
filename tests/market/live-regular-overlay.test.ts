/**
 * Pure tests for `applyLiveRegularOverlay` — the REGULAR-hours overlay that
 * bakes today's live price into the daily close series, anchored on the
 * quote's ET trade date, keeping the close-to-close chain intact.
 */
import { describe, it, expect } from "vitest";
import {
  applyLiveRegularOverlay,
  liveRegular1D,
} from "../../src/server/services/market-map.service";
import type { DateClose } from "../../src/domain/calculations/alignment";
import type { LiveRegularQuote } from "../../src/server/services/live-regular.service";
import { securityHorizonMetrics } from "../../src/domain/calculations/security-metrics";

function makeSeries(closes: number[], startIso = "2026-06-01"): DateClose[] {
  const start = new Date(`${startIso}T00:00:00Z`);
  return closes.map((c, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    return { date: d.toISOString().slice(0, 10), adjClose: c };
  });
}

function quote(
  tradeDateEt: string,
  price: number,
  prevClose = 100,
): LiveRegularQuote {
  return { price, prevClose, asOfUnix: 0, tradeDateEt };
}

describe("applyLiveRegularOverlay", () => {
  it("appends a today-ET bar when the DB series lags the trade date", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-04", 105), "live");
    expect(r.applied).toBe(true);
    expect(r.series).toHaveLength(4);
    expect(r.series[3]).toEqual({ date: "2026-06-04", adjClose: 105 });
    // Prior bars untouched.
    expect(r.series.slice(0, 3)).toEqual(s);
  });

  it("live mode REPLACES a same-day bar (seeded partial superseded)", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-03", 109), "live");
    expect(r.applied).toBe(true);
    expect(r.series).toHaveLength(3);
    expect(r.series[2]).toEqual({ date: "2026-06-03", adjClose: 109 });
  });

  it("frozen mode is a NO-OP on a same-day bar (official close preserved)", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-03", 109), "frozen");
    expect(r.applied).toBe(false);
    expect(r.skipReason).toBe("frozen_noop");
    expect(r.series).toBe(s);
  });

  it("frozen mode still APPENDS when the DB lags the trade date", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-04", 105), "frozen");
    expect(r.applied).toBe(true);
    expect(r.series[3]).toEqual({ date: "2026-06-04", adjClose: 105 });
  });

  it("skips a DB bar dated after the print (future_bar)", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-02", 105), "live");
    expect(r.applied).toBe(false);
    expect(r.skipReason).toBe("future_bar");
    expect(r.series).toBe(s);
  });

  it("appends across a Fri->Mon weekend gap (3 calendar days)", () => {
    const friSeries: DateClose[] = [
      { date: "2026-06-04", adjClose: 100 },
      { date: "2026-06-05", adjClose: 101 }, // Friday
    ];
    const r = applyLiveRegularOverlay(friSeries, quote("2026-06-08", 105), "live");
    expect(r.applied).toBe(true);
    expect(r.series[2]).toEqual({ date: "2026-06-08", adjClose: 105 });
  });

  it("skips when the DB lags the trade date by more than 3 days (stale_db)", () => {
    const s = makeSeries([100, 101, 102]); // last = 2026-06-03
    const r = applyLiveRegularOverlay(s, quote("2026-06-10", 105), "live");
    expect(r.applied).toBe(false);
    expect(r.skipReason).toBe("stale_db");
    expect(r.series).toBe(s);
  });

  it("appends across a single-day holiday (Thu -> Mon over July 4th)", () => {
    // Last bar Thu 2026-07-02; Fri 2026-07-03 was the observed Independence Day
    // holiday, so the DB is current and the overlay must APPLY — the calendar
    // gap is 4 days but only the closed Friday sits between (1 missed weekday).
    const holidaySeries: DateClose[] = [
      { date: "2026-07-01", adjClose: 100 },
      { date: "2026-07-02", adjClose: 101 }, // Thursday
    ];
    const r = applyLiveRegularOverlay(holidaySeries, quote("2026-07-06", 105), "live");
    expect(r.applied).toBe(true);
    expect(r.series[2]).toEqual({ date: "2026-07-06", adjClose: 105 });
  });

  it("no-ops on a non-finite price", () => {
    const s = makeSeries([100, 101, 102]);
    expect(applyLiveRegularOverlay(s, quote("2026-06-04", NaN), "live").series).toBe(s);
    expect(
      applyLiveRegularOverlay(s, quote("2026-06-04", Infinity), "live").applied,
    ).toBe(false);
  });

  it("no-ops on an empty series", () => {
    const r = applyLiveRegularOverlay([], quote("2026-06-04", 105), "live");
    expect(r.applied).toBe(false);
    expect(r.skipReason).toBe("empty");
  });

  it("recomputes all horizons; D1 = price / prior close", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i); // 100..109
    const s = makeSeries(closes); // last = 2026-06-10
    const r = applyLiveRegularOverlay(s, quote("2026-06-11", 120), "live");
    const m = securityHorizonMetrics(r.series, null, 0);
    // D1 against the prior close (109).
    expect(m.D1.return).toBeCloseTo(120 / 109 - 1, 12);
    // 5D telescopes to price / close 5 bars back (105 -> index 5 = 105).
    expect(m.D5.return).toBeCloseTo(120 / 105 - 1, 12);
  });
});

describe("liveRegular1D (prevClose-anchored 1D)", () => {
  it("live mode: 1D = price / prevClose - 1, independent of the series", () => {
    // price 6.01, prevClose (Friday) 5.97 -> ~+0.67%, the correct intraday 1D.
    expect(liveRegular1D(quote("2026-06-29", 6.01, 5.97), "live")).toBeCloseTo(
      6.01 / 5.97 - 1,
      12,
    );
  });

  it("missing-Friday tape: overlay applies but the anchor keeps D1 correct", () => {
    // Stored series ends Thursday with Friday missing. A single missing weekday
    // is indistinguishable from a market holiday without a holiday calendar, so
    // the overlay now APPLIES (tolerating one missed trading day). The appended
    // Monday bar then chains off the stale Thursday close, so the chain-derived
    // D1 is wrong — exactly the case the prevClose anchor must rescue.
    const thuSeries: DateClose[] = [
      { date: "2026-06-18", adjClose: 5.0 },
      { date: "2026-06-19", adjClose: 5.1 },
      { date: "2026-06-22", adjClose: 5.2 },
      { date: "2026-06-23", adjClose: 5.15 },
      { date: "2026-06-24", adjClose: 5.29 },
      { date: "2026-06-25", adjClose: 5.08 }, // Thursday (Friday missing)
    ];
    const monQuote = quote("2026-06-29", 5.35, 5.97);
    const overlaid = applyLiveRegularOverlay(thuSeries, monQuote, "live");
    expect(overlaid.applied).toBe(true);
    expect(overlaid.series[overlaid.series.length - 1]).toEqual({
      date: "2026-06-29",
      adjClose: 5.35,
    });
    // The chain would mis-report 1D as the Thu->Mon move (Friday's close is
    // missing from the series)…
    const chainedD1 = securityHorizonMetrics(overlaid.series, null, 0).D1.return;
    expect(chainedD1).toBeCloseTo(5.35 / 5.08 - 1, 12); // spans the gap, wrong
    // …but the anchor uses Friday's prevClose for the correct Mon 1D.
    const anchored = liveRegular1D(monQuote, "live")!;
    expect(anchored).toBeCloseTo(5.35 / 5.97 - 1, 12);
    expect(anchored).not.toBeCloseTo(chainedD1!, 6);
  });

  it("frozen mode returns null (chain / official close wins)", () => {
    expect(liveRegular1D(quote("2026-06-29", 6.01, 5.97), "frozen")).toBeNull();
  });

  it("invalid prevClose (0 / NaN) returns null (falls back to chain)", () => {
    expect(liveRegular1D(quote("2026-06-29", 6.01, 0), "live")).toBeNull();
    expect(liveRegular1D(quote("2026-06-29", 6.01, NaN), "live")).toBeNull();
    expect(
      liveRegular1D(quote("2026-06-29", NaN, 5.97), "live"),
    ).toBeNull();
  });
});
