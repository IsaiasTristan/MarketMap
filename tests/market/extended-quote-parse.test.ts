/**
 * Pure tests for `parseYahooExtendedQuote` — the synthetic-payload parser
 * underneath `fetchYahooExtendedQuote`. Each case mirrors the shape Yahoo
 * returns from `?includePrePost=true` for a different session state.
 */
import { describe, it, expect } from "vitest";
import { parseYahooExtendedQuote } from "../../src/infrastructure/providers/yahoo-chart-http";

// Synthetic boundaries — Wed 2026-06-17 (summer EDT = UTC-4).
//   pre:     04:00-09:30 ET -> 08:00-13:30 UTC
//   regular: 09:30-16:00 ET -> 13:30-20:00 UTC
//   post:    16:00-20:00 ET -> 20:00-24:00 UTC
const DATE_UTC = Date.UTC(2026, 5, 17, 0); // base 00:00 UTC
const SEC = 60;
const PRE_START = (DATE_UTC + 8 * 3600 * 1000) / 1000;
const REG_START = (DATE_UTC + 13.5 * 3600 * 1000) / 1000;
const REG_END = (DATE_UTC + 20 * 3600 * 1000) / 1000;
const POST_END = (DATE_UTC + 24 * 3600 * 1000) / 1000;

const PERIOD = {
  pre: { start: PRE_START, end: REG_START },
  regular: { start: REG_START, end: REG_END },
  post: { start: REG_END, end: POST_END },
};

describe("parseYahooExtendedQuote", () => {
  it("returns null when timestamp array is empty", () => {
    expect(
      parseYahooExtendedQuote({
        timestamp: [],
        indicators: { quote: [{ close: [] }] },
        meta: { currentTradingPeriod: PERIOD },
      }),
    ).toBeNull();
  });

  it("returns null when every close is null (thin session, no prints)", () => {
    expect(
      parseYahooExtendedQuote({
        timestamp: [PRE_START + 5 * SEC, PRE_START + 10 * SEC],
        indicators: { quote: [{ close: [null, null] }] },
        meta: { currentTradingPeriod: PERIOD },
      }),
    ).toBeNull();
  });

  it("classifies the latest print as POST when it falls in the post window", () => {
    const r = parseYahooExtendedQuote({
      timestamp: [REG_START + 60 * SEC, REG_END + 60 * SEC],
      indicators: { quote: [{ close: [150.5, 151.25] }] },
      meta: {
        chartPreviousClose: 148,
        regularMarketPrice: 150.5,
        currentTradingPeriod: PERIOD,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("POST");
    expect(r!.price).toBeCloseTo(151.25, 6);
    expect(r!.prevClose).toBeCloseTo(148, 6);
    // POST exposes today's regular close (= 4pm regularMarketPrice).
    expect(r!.regularClose).toBeCloseTo(150.5, 6);
  });

  it("classifies the latest print as PRE when it falls in the pre window", () => {
    const r = parseYahooExtendedQuote({
      timestamp: [PRE_START + 60 * SEC, PRE_START + 120 * SEC],
      indicators: { quote: [{ close: [149.1, 149.4] }] },
      meta: {
        chartPreviousClose: 148,
        // During PRE, Yahoo's `regularMarketPrice` points at yesterday's
        // close — we should NOT surface it as `regularClose`.
        regularMarketPrice: 148,
        currentTradingPeriod: PERIOD,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("PRE");
    expect(r!.price).toBeCloseTo(149.4, 6);
    expect(r!.regularClose).toBeNull();
  });

  it("skips trailing null closes and picks the latest finite print", () => {
    const r = parseYahooExtendedQuote({
      timestamp: [
        REG_END + 30 * SEC,
        REG_END + 60 * SEC,
        REG_END + 90 * SEC,
      ],
      indicators: { quote: [{ close: [151, null, null] }] },
      meta: { chartPreviousClose: 148, currentTradingPeriod: PERIOD },
    });
    expect(r).not.toBeNull();
    expect(r!.price).toBeCloseTo(151, 6);
    expect(r!.session).toBe("POST");
    expect(r!.asOfUnix).toBe(REG_END + 30 * SEC);
  });

  it("classifies by ET time-of-day when currentTradingPeriod is missing", () => {
    // No `currentTradingPeriod` — parser falls back to ET-clock
    // classification. 16:01 ET on a Wednesday is POST hours, so the
    // print is correctly labelled POST.
    const r = parseYahooExtendedQuote({
      timestamp: [REG_END + 60 * SEC],
      indicators: { quote: [{ close: [151] }] },
      meta: { chartPreviousClose: 148 },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("POST");
  });

  it("classifies a prior-day POST bar correctly via ET-clock fallback", () => {
    // Backfill scenario: Yahoo's currentTradingPeriod describes TODAY (Wed
    // 2026-06-17) but the latest non-null bar is from the previous trading
    // day's POST window (Tue 2026-06-16 ~19:55 ET). The period check fails
    // (the bar is before today's pre.start), and the ET-clock fallback
    // takes over to recognise it as POST. This is the key path that lets
    // the CLOSED-startup backfill recover yesterday's after-hours move
    // when no admin's browser was open to keep the snapshot warm.
    const YESTERDAY_POST_UNIX =
      (Date.UTC(2026, 5, 16, 23, 55) / 1000); // 19:55 ET (EDT = UTC-4)
    const r = parseYahooExtendedQuote({
      timestamp: [YESTERDAY_POST_UNIX],
      indicators: { quote: [{ close: [151.5] }] },
      meta: { chartPreviousClose: 148, currentTradingPeriod: PERIOD },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("POST");
    expect(r!.price).toBeCloseTo(151.5, 6);
    expect(r!.asOfUnix).toBe(YESTERDAY_POST_UNIX);
  });

  it("returns null on a malformed (null) result frame", () => {
    expect(parseYahooExtendedQuote(null)).toBeNull();
    expect(parseYahooExtendedQuote(undefined)).toBeNull();
  });

  it("picks the latest POST bar when the chronologically last bar is REGULAR", () => {
    const r = parseYahooExtendedQuote({
      timestamp: [REG_END - 60 * SEC, REG_END + 60 * SEC],
      indicators: { quote: [{ close: [150.5, 151.25] }] },
      meta: {
        chartPreviousClose: 148,
        regularMarketPrice: 150.5,
        currentTradingPeriod: PERIOD,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("POST");
    expect(r!.price).toBeCloseTo(151.25, 6);
    expect(r!.asOfUnix).toBe(REG_END + 60 * SEC);
  });

  it("picks Monday POST over Friday REGULAR on a 5d backfill window", () => {
    const FRIDAY_REG_UNIX = (Date.UTC(2026, 5, 19, 20, 0) / 1000); // Fri 4pm ET
    const MONDAY_POST_UNIX = (Date.UTC(2026, 5, 22, 23, 55) / 1000); // Mon 7:55pm ET
    const r = parseYahooExtendedQuote({
      timestamp: [FRIDAY_REG_UNIX, MONDAY_POST_UNIX],
      indicators: { quote: [{ close: [209.83, 209.6] }] },
      meta: {
        chartPreviousClose: 195,
        regularMarketPrice: 209.83,
        currentTradingPeriod: PERIOD,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.session).toBe("POST");
    expect(r!.price).toBeCloseTo(209.6, 6);
    expect(r!.asOfUnix).toBe(MONDAY_POST_UNIX);
  });
});
