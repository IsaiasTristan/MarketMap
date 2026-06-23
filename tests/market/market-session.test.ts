/**
 * Pure tests for the four-state US market session classifier.
 *
 * Dates are constructed in UTC and the classifier converts to America/New_York
 * via Intl. We pick a weekday in winter (EST = UTC-5) and one in summer
 * (EDT = UTC-4) so the test exercises both standard and daylight time without
 * being sensitive to where DST boundaries land.
 */
import { describe, it, expect } from "vitest";
import {
  classifyEtTimeOfDay,
  getUsMarketSession,
  isExtendedSession,
  tradeDateEtFromUnix,
} from "../../src/lib/market-map/market-session";

// Wed 2026-02-04 is a winter weekday (EST = UTC-5).
const ET_HOUR_OFFSET_WINTER = 5; // UTC = ET + 5
function winterEt(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 1, 4, hour + ET_HOUR_OFFSET_WINTER, minute));
}

// Wed 2026-06-17 is a summer weekday (EDT = UTC-4).
const ET_HOUR_OFFSET_SUMMER = 4;
function summerEt(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 5, 17, hour + ET_HOUR_OFFSET_SUMMER, minute));
}

describe("getUsMarketSession — weekday boundaries (winter EST)", () => {
  it("just before 04:00 ET is CLOSED", () => {
    expect(getUsMarketSession(winterEt(3, 59))).toBe("CLOSED");
  });

  it("04:00 ET enters PRE", () => {
    expect(getUsMarketSession(winterEt(4, 0))).toBe("PRE");
  });

  it("09:29 ET still PRE", () => {
    expect(getUsMarketSession(winterEt(9, 29))).toBe("PRE");
  });

  it("09:30 ET enters REGULAR", () => {
    expect(getUsMarketSession(winterEt(9, 30))).toBe("REGULAR");
  });

  it("15:59 ET still REGULAR", () => {
    expect(getUsMarketSession(winterEt(15, 59))).toBe("REGULAR");
  });

  it("16:00 ET enters POST", () => {
    expect(getUsMarketSession(winterEt(16, 0))).toBe("POST");
  });

  it("19:59 ET still POST", () => {
    expect(getUsMarketSession(winterEt(19, 59))).toBe("POST");
  });

  it("20:00 ET is CLOSED", () => {
    expect(getUsMarketSession(winterEt(20, 0))).toBe("CLOSED");
  });
});

describe("getUsMarketSession — weekday boundaries (summer EDT)", () => {
  it("PRE / REGULAR / POST identified across DST", () => {
    expect(getUsMarketSession(summerEt(5, 0))).toBe("PRE");
    expect(getUsMarketSession(summerEt(12, 0))).toBe("REGULAR");
    expect(getUsMarketSession(summerEt(17, 30))).toBe("POST");
    expect(getUsMarketSession(summerEt(22, 0))).toBe("CLOSED");
  });
});

describe("getUsMarketSession — weekends", () => {
  it("Saturday at noon ET is CLOSED regardless of clock hour", () => {
    // Saturday 2026-02-07 at 12:00 ET = 17:00 UTC
    const sat = new Date(Date.UTC(2026, 1, 7, 12 + 5, 0));
    expect(getUsMarketSession(sat)).toBe("CLOSED");
  });

  it("Sunday at 10:00 ET is CLOSED", () => {
    const sun = new Date(Date.UTC(2026, 1, 8, 10 + 5, 0));
    expect(getUsMarketSession(sun)).toBe("CLOSED");
  });
});

describe("isExtendedSession", () => {
  it("flags PRE and POST as extended; REGULAR and CLOSED are not", () => {
    expect(isExtendedSession("PRE")).toBe(true);
    expect(isExtendedSession("POST")).toBe(true);
    expect(isExtendedSession("REGULAR")).toBe(false);
    expect(isExtendedSession("CLOSED")).toBe(false);
  });
});

describe("classifyEtTimeOfDay — day-of-week-agnostic time-of-day classifier", () => {
  // Each timestamp is an epoch *seconds* value; the helper interprets it in
  // America/New_York. We exercise the same boundary set as `getUsMarketSession`
  // but for the time-of-day portion only — the day of week is irrelevant.
  const unix = (d: Date) => d.getTime() / 1000;

  it("classifies winter ET 04:00 boundary as PRE", () => {
    expect(classifyEtTimeOfDay(unix(winterEt(4, 0)))).toBe("PRE");
    expect(classifyEtTimeOfDay(unix(winterEt(9, 29)))).toBe("PRE");
  });

  it("classifies winter ET regular window as REGULAR", () => {
    expect(classifyEtTimeOfDay(unix(winterEt(9, 30)))).toBe("REGULAR");
    expect(classifyEtTimeOfDay(unix(winterEt(15, 59)))).toBe("REGULAR");
  });

  it("classifies winter ET POST window as POST", () => {
    expect(classifyEtTimeOfDay(unix(winterEt(16, 0)))).toBe("POST");
    expect(classifyEtTimeOfDay(unix(winterEt(19, 59)))).toBe("POST");
  });

  it("classifies overnight gap as REGULAR (defensive fallback)", () => {
    // 02:00 ET is outside every defined session — return REGULAR so any
    // bar that somehow landed here gets filtered by the sweep rather than
    // misclassified as an extended-hours print.
    expect(classifyEtTimeOfDay(unix(winterEt(2, 0)))).toBe("REGULAR");
    expect(classifyEtTimeOfDay(unix(winterEt(22, 0)))).toBe("REGULAR");
  });

  it("classifies bars from a SATURDAY POST hour as POST", () => {
    // Saturday at 18:00 ET — day of week is irrelevant; only time-of-day
    // matters. This is the path exercised by a weekend CLOSED-startup
    // backfill where Yahoo's `currentTradingPeriod` describes Monday but
    // the bars in the response are from Friday's POST window.
    const sat = new Date(Date.UTC(2026, 1, 7, 18 + 5, 0)); // Sat 18:00 EST
    expect(classifyEtTimeOfDay(unix(sat))).toBe("POST");
  });

  it("respects DST — 18:00 EDT in summer also classifies as POST", () => {
    expect(classifyEtTimeOfDay(unix(summerEt(18, 0)))).toBe("POST");
    expect(classifyEtTimeOfDay(unix(summerEt(8, 0)))).toBe("PRE");
    expect(classifyEtTimeOfDay(unix(summerEt(12, 0)))).toBe("REGULAR");
  });
});

describe("tradeDateEtFromUnix", () => {
  const unix = (d: Date) => d.getTime() / 1000;

  it("maps 11:59pm ET to the same calendar date", () => {
    const late = new Date(Date.UTC(2026, 5, 23, 3, 59)); // Jun 22 11:59pm EDT
    expect(tradeDateEtFromUnix(unix(late))).toBe("2026-06-22");
  });

  it("maps 12:01am ET to the next calendar date", () => {
    const afterMidnight = new Date(Date.UTC(2026, 5, 23, 4, 1)); // Jun 23 12:01am EDT
    expect(tradeDateEtFromUnix(unix(afterMidnight))).toBe("2026-06-23");
  });
});
