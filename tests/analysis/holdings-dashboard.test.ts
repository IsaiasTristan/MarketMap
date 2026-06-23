import { describe, expect, it } from "vitest";
import { buildCohortStats } from "@/lib/holdings/cohort-stats";
import {
  dayRangeMarkerPosition,
  signedPeriodReturn,
} from "@/lib/holdings/day-range";
import {
  composeCurrentSparkline,
  splitIntradayByEtDate,
  splitIntradaySessions,
} from "@/lib/holdings/intraday-split";
import { computePctRank } from "@/lib/factors/screener/derived";

function etUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

describe("dayRangeMarkerPosition", () => {
  it("returns 0 at low", () => {
    expect(dayRangeMarkerPosition(100, 110, 100)).toBe(0);
  });

  it("returns 1 at high", () => {
    expect(dayRangeMarkerPosition(100, 110, 110)).toBe(1);
  });

  it("returns 0.5 at midpoint", () => {
    expect(dayRangeMarkerPosition(100, 110, 105)).toBe(0.5);
  });

  it("clamps below low and above high", () => {
    expect(dayRangeMarkerPosition(100, 110, 95)).toBe(0);
    expect(dayRangeMarkerPosition(100, 110, 115)).toBe(1);
  });

  it("returns 0.5 when high <= low", () => {
    expect(dayRangeMarkerPosition(100, 100, 100)).toBe(0.5);
    expect(dayRangeMarkerPosition(110, 100, 105)).toBe(0.5);
  });
});

describe("signedPeriodReturn", () => {
  it("computes long return", () => {
    expect(signedPeriodReturn(110, 100, false)).toBeCloseTo(0.1);
  });

  it("flips sign for shorts", () => {
    expect(signedPeriodReturn(110, 100, true)).toBeCloseTo(-0.1);
  });

  it("returns 0 for invalid start", () => {
    expect(signedPeriodReturn(110, 0, false)).toBe(0);
  });
});

describe("splitIntradayByEtDate", () => {
  it("splits Friday prev session from Monday today on a Mon midday ref", () => {
    const fri = [
      etUnix("2025-06-20T10:00:00-04:00"),
      etUnix("2025-06-20T12:00:00-04:00"),
      etUnix("2025-06-20T15:30:00-04:00"),
    ];
    const mon = [
      etUnix("2025-06-23T10:00:00-04:00"),
      etUnix("2025-06-23T12:00:00-04:00"),
    ];
    const ts = [...fri, ...mon];
    const closes = [100, 101, 102, 103, 104];
    const now = new Date("2025-06-23T12:00:00-04:00");

    const { todayCloses, prevDayCloses } = splitIntradayByEtDate(
      ts,
      closes,
      now,
    );

    expect(prevDayCloses).toEqual([100, 101, 102]);
    expect(todayCloses).toEqual([103, 104]);
  });

  it("returns empty today when pre-open Monday has only Friday bars", () => {
    const fri = [
      etUnix("2025-06-20T10:00:00-04:00"),
      etUnix("2025-06-20T15:30:00-04:00"),
    ];
    const closes = [50, 51];
    const now = new Date("2025-06-23T08:00:00-04:00");

    const { todayCloses, prevDayCloses } = splitIntradayByEtDate(
      fri,
      closes,
      now,
    );

    expect(todayCloses).toEqual([]);
    expect(prevDayCloses).toEqual([50, 51]);
  });

  it("returns empty prevDay when payload is single-day only", () => {
    const ts = [
      etUnix("2025-06-23T10:00:00-04:00"),
      etUnix("2025-06-23T15:30:00-04:00"),
    ];
    const closes = [200, 201];
    const now = new Date("2025-06-23T16:00:00-04:00");

    const { todayCloses, prevDayCloses } = splitIntradayByEtDate(
      ts,
      closes,
      now,
    );

    expect(todayCloses).toEqual([200, 201]);
    expect(prevDayCloses).toEqual([]);
  });

  it("splits Jun 17 prev session from Jun 23 today after holiday gap", () => {
    const jun17 = [
      etUnix("2026-06-17T10:00:00-04:00"),
      etUnix("2026-06-17T12:00:00-04:00"),
      etUnix("2026-06-17T15:30:00-04:00"),
    ];
    const jun23 = [
      etUnix("2026-06-23T10:00:00-04:00"),
      etUnix("2026-06-23T12:00:00-04:00"),
      etUnix("2026-06-23T14:00:00-04:00"),
    ];
    const ts = [...jun17, ...jun23];
    const closes = [100, 101, 102, 110, 111, 112];
    const now = new Date("2026-06-23T12:00:00-04:00");

    const { todayCloses, prevDayCloses } = splitIntradayByEtDate(
      ts,
      closes,
      now,
    );

    expect(prevDayCloses.length).toBeGreaterThan(1);
    expect(todayCloses.length).toBeGreaterThan(1);
    expect(prevDayCloses[0]).toBe(100);
    expect(todayCloses[0]).toBe(110);
  });

  it("falls back to all closes as today when timestamps are missing", () => {
    const closes = [50, 51, 52, 53];
    const { todayCloses, prevDayCloses } = splitIntradayByEtDate([], closes);

    expect(todayCloses).toEqual([50, 51, 52, 53]);
    expect(prevDayCloses).toEqual([]);
  });
});

describe("composeCurrentSparkline", () => {
  it("carries last regular session + POST when pre-open on the next day", () => {
    const jun22Reg = [
      etUnix("2026-06-22T10:00:00-04:00"),
      etUnix("2026-06-22T12:00:00-04:00"),
      etUnix("2026-06-22T15:30:00-04:00"),
    ];
    const jun22Post = [
      etUnix("2026-06-22T17:00:00-04:00"),
      etUnix("2026-06-22T18:30:00-04:00"),
    ];
    const ts = [...jun22Reg, ...jun22Post];
    const closes = [100, 101, 102, 103, 104];
    const sessions = splitIntradaySessions(ts, closes);
    const now = new Date("2026-06-23T08:00:00-04:00");

    const { regular, extended } = composeCurrentSparkline(sessions, now);

    expect(regular).toEqual([100, 101, 102]);
    expect(extended).toEqual([103, 104]);
  });

  it("uses today's regular session during regular hours", () => {
    const jun23Reg = [
      etUnix("2026-06-23T10:00:00-04:00"),
      etUnix("2026-06-23T12:00:00-04:00"),
      etUnix("2026-06-23T14:00:00-04:00"),
    ];
    const closes = [110, 111, 112];
    const sessions = splitIntradaySessions(jun23Reg, closes);
    const now = new Date("2026-06-23T12:00:00-04:00");

    const { regular, extended } = composeCurrentSparkline(sessions, now);

    expect(regular).toEqual([110, 111, 112]);
    expect(extended).toEqual([]);
  });

  it("suppresses today's PRE tail during regular hours when pre-market bars exist", () => {
    const jun23Pre = [
      etUnix("2026-06-23T08:00:00-04:00"),
      etUnix("2026-06-23T09:00:00-04:00"),
    ];
    const jun23Reg = [
      etUnix("2026-06-23T10:00:00-04:00"),
      etUnix("2026-06-23T12:00:00-04:00"),
      etUnix("2026-06-23T14:00:00-04:00"),
    ];
    const ts = [...jun23Pre, ...jun23Reg];
    const closes = [108, 109, 110, 111, 112];
    const sessions = splitIntradaySessions(ts, closes);
    const now = new Date("2026-06-23T12:00:00-04:00");

    const { regular, extended } = composeCurrentSparkline(sessions, now);

    expect(regular).toEqual([110, 111, 112]);
    expect(extended).toEqual([]);
  });

  it("appends today's POST tail during after-hours", () => {
    const jun23Reg = [
      etUnix("2026-06-23T10:00:00-04:00"),
      etUnix("2026-06-23T15:30:00-04:00"),
    ];
    const jun23Post = [
      etUnix("2026-06-23T17:00:00-04:00"),
      etUnix("2026-06-23T18:00:00-04:00"),
    ];
    const ts = [...jun23Reg, ...jun23Post];
    const closes = [200, 201, 202, 203];
    const sessions = splitIntradaySessions(ts, closes);
    const now = new Date("2026-06-23T18:30:00-04:00");

    const { regular, extended } = composeCurrentSparkline(sessions, now);

    expect(regular).toEqual([200, 201]);
    expect(extended).toEqual([202, 203]);
  });
});

describe("splitIntradaySessions", () => {
  it("routes PRE and POST bars into separate buckets", () => {
    const ts = [
      etUnix("2026-06-23T08:00:00-04:00"),
      etUnix("2026-06-23T12:00:00-04:00"),
      etUnix("2026-06-23T17:00:00-04:00"),
    ];
    const closes = [108, 110, 112];
    const sessions = splitIntradaySessions(ts, closes);

    expect(sessions.byDatePre.get("2026-06-23")).toEqual([108]);
    expect(sessions.byDateRegular.get("2026-06-23")).toEqual([110]);
    expect(sessions.byDatePost.get("2026-06-23")).toEqual([112]);
  });
});

describe("cohort percentile via buildCohortStats + computePctRank", () => {
  it("ranks a value within a synthetic cohort", () => {
    const cohort = [-0.05, -0.02, 0, 0.01, 0.03, 0.05];
    const stats = buildCohortStats(cohort);
    expect(computePctRank(0.03, stats)).toBe(75);
    expect(computePctRank(-0.05, stats)).toBe(8);
    expect(computePctRank(0.05, stats)).toBe(92);
  });

  it("returns null for empty cohort", () => {
    const stats = buildCohortStats([]);
    expect(computePctRank(0.01, stats)).toBeNull();
  });
});
