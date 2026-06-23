import { describe, it, expect } from "vitest";
import {
  computeSeamLayout,
  computeSessionProgress,
  computeTodayOnlyLayout,
  DEFAULT_PRIOR_ZONE_FRAC,
  mapSeriesToX,
  sessionFractionToEtLabel,
  timestampToSessionFraction,
} from "../../src/lib/market/sparkline-session-layout";

// Mon 2026-06-23 — summer weekday (EDT = UTC-4).
const ET_OFFSET = 4;
function et(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 5, 23, hour + ET_OFFSET, minute));
}

describe("computeSessionProgress — us_regular", () => {
  it("returns 0 at 09:30 ET open", () => {
    expect(computeSessionProgress(et(9, 30), "us_regular")).toBe(0);
  });

  it("returns ~0.385 at 12:00 ET midday", () => {
    const p = computeSessionProgress(et(12, 0), "us_regular");
    expect(p).toBeCloseTo(150 / 390, 3);
  });

  it("returns 1 at 16:00 ET close", () => {
    expect(computeSessionProgress(et(16, 0), "us_regular")).toBe(1);
  });

  it("returns 1 during POST", () => {
    expect(computeSessionProgress(et(17, 0), "us_regular")).toBe(1);
  });

  it("returns 0 during PRE", () => {
    expect(computeSessionProgress(et(8, 0), "us_regular")).toBe(0);
  });
});

describe("computeSessionProgress — et_calendar_day", () => {
  it("returns 0.5 at noon ET", () => {
    expect(computeSessionProgress(et(12, 0), "et_calendar_day")).toBeCloseTo(
      0.5,
      5,
    );
  });
});

describe("mapSeriesToX", () => {
  it("maps endpoints to xStart and xEnd", () => {
    expect(mapSeriesToX(0, 5, 10, 20)).toBe(10);
    expect(mapSeriesToX(4, 5, 10, 20)).toBe(20);
  });

  it("maps a single point to the midpoint", () => {
    expect(mapSeriesToX(0, 1, 10, 20)).toBe(15);
  });
});

describe("computeSeamLayout", () => {
  const totalWidth = 60;

  it("places joinX at priorZoneFrac × totalWidth", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: true,
      hasExtended: false,
      now: et(12, 0),
    });
    expect(layout.joinX).toBeCloseTo(totalWidth * DEFAULT_PRIOR_ZONE_FRAC, 5);
  });

  it("today zone only fills sessionProgress fraction at midday", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: true,
      hasExtended: false,
      now: et(12, 0),
    });
    const todayZone = totalWidth - layout.joinX;
    const expectedEnd =
      layout.joinX + todayZone * computeSessionProgress(et(12, 0), "us_regular");
    expect(layout.todayActiveEndX).toBeCloseTo(expectedEnd, 5);
    expect(layout.todayActiveEndX).toBeLessThan(totalWidth);
  });

  it("10 today points at 10% progress occupy ~3.5% of total width", () => {
    const progress = 0.1;
    const joinX = totalWidth * DEFAULT_PRIOR_ZONE_FRAC;
    const todayZone = totalWidth - joinX;
    const todayEnd = joinX + todayZone * progress;
    const span = todayEnd - joinX;
    const totalSpanPct = span / totalWidth;
    expect(totalSpanPct).toBeCloseTo(0.035, 2);
    expect(totalSpanPct).toBeLessThan(0.1);
  });

  it("prior series ends at joinX and today starts at joinX", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: true,
      hasExtended: false,
      now: et(10, 0),
    });
    expect(layout.priorXRange[1]).toBe(layout.joinX);
    expect(layout.todayXRange[0]).toBe(layout.joinX);
  });

  it("shows divider when prior and today both present", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: true,
      hasExtended: false,
      now: et(10, 0),
    });
    expect(layout.showDivider).toBe(true);
  });

  it("handles empty prior — today still starts at joinX", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: false,
      hasToday: true,
      hasExtended: false,
      now: et(10, 0),
    });
    expect(layout.showDivider).toBe(false);
    expect(layout.todayXRange[0]).toBe(layout.joinX);
  });

  it("handles empty today — prior still fills left zone", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: false,
      hasExtended: false,
      now: et(10, 0),
    });
    expect(layout.priorXRange[1]).toBe(layout.joinX);
    expect(layout.todayXRange[0]).toBe(layout.todayXRange[1]);
  });

  it("exposes extended range during PRE when extended data exists", () => {
    const layout = computeSeamLayout({
      totalWidth,
      timeMode: "us_regular",
      hasPrior: true,
      hasToday: false,
      hasExtended: true,
      now: et(8, 0),
      clockSession: "PRE",
    });
    expect(layout.extendedXRange).not.toBeNull();
    expect(layout.extendedXRange![0]).toBe(layout.joinX);
    expect(layout.extendedXRange![1]).toBe(totalWidth);
  });
});

describe("timestampToSessionFraction", () => {
  it("returns 0 at 09:30 ET open", () => {
    expect(timestampToSessionFraction(et(9, 30).toISOString())).toBe(0);
  });

  it("returns ~0.385 at 12:00 ET midday", () => {
    expect(timestampToSessionFraction(et(12, 0).toISOString())).toBeCloseTo(
      150 / 390,
      3,
    );
  });

  it("returns 1 at 16:00 ET close", () => {
    expect(timestampToSessionFraction(et(16, 0).toISOString())).toBe(1);
  });
});

describe("sessionFractionToEtLabel", () => {
  it("formats session open and close", () => {
    expect(sessionFractionToEtLabel(0)).toBe("9:30 AM");
    expect(sessionFractionToEtLabel(1)).toBe("4:00 PM");
  });
});

describe("computeTodayOnlyLayout", () => {
  it("today zone fills sessionProgress fraction of total width", () => {
    const now = et(10, 9); // ~10% into regular session
    const layout = computeTodayOnlyLayout({
      hasToday: true,
      hasExtended: false,
      now,
    });
    expect(layout.todayXRange[1]).toBeCloseTo(layout.sessionProgress, 5);
    expect(layout.todayXRange[1]).toBeCloseTo(0.1, 1);
  });

  it("starts today at 0 without prior zone", () => {
    const layout = computeTodayOnlyLayout({
      hasToday: true,
      hasExtended: false,
      now: et(12, 0),
    });
    expect(layout.todayXRange[0]).toBe(0);
  });
});
