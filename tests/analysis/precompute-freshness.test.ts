/**
 * Tests for the precompute-freshness helper. Pure, deterministic — we inject
 * `now` and use a fake Prisma client so no DB or wall clock is involved.
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  getPrecomputeFreshness,
  isPriceTailStale,
  isStaleSinceLastClose,
  lastTradingClose,
} from "../../src/lib/factors/diagnostics/precompute-freshness";

interface Row {
  regressionWindow: number;
  asOfDate: Date;
  computedAt: Date;
}

function makeFakeDb(rows: Row[]): PrismaClient {
  return {
    perStockGridSnapshot: {
      findMany: async () => rows.slice().sort((a, b) => a.regressionWindow - b.regressionWindow),
    },
  } as unknown as PrismaClient;
}

describe("isStaleSinceLastClose", () => {
  // Monday 2026-06-29 21:00 local (after close) -> last completed session close
  // is Monday 2026-06-29 17:00.
  const monEvening = new Date(2026, 5, 29, 21, 0, 0);

  it("stale when computed before the last completed close (Sunday vs Monday)", () => {
    // The real bug: cache computed Sunday night, viewed Monday evening.
    const sundayNight = new Date(2026, 5, 28, 23, 28, 0);
    expect(isStaleSinceLastClose(sundayNight, monEvening)).toBe(true);
  });

  it("treats a missing artifact (null) as stale", () => {
    expect(isStaleSinceLastClose(null, monEvening)).toBe(true);
  });

  it("fresh when computed after the last completed close", () => {
    const monAfterClose = new Date(2026, 5, 29, 17, 5, 0);
    expect(isStaleSinceLastClose(monAfterClose, monEvening)).toBe(false);
  });

  it("fresh intraday for a row computed earlier the same trading day", () => {
    // Tuesday 11:00 local (before today's close) -> last close is Monday 17:00.
    const tueMorning = new Date(2026, 5, 30, 11, 0, 0);
    // Row computed Tuesday 09:00, before today's close but after Monday's.
    const tueEarly = new Date(2026, 5, 30, 9, 0, 0);
    expect(isStaleSinceLastClose(tueEarly, tueMorning)).toBe(false);
  });
});

describe("isPriceTailStale", () => {
  // Monday 2026-06-29 09:00 local (before close) -> last completed session is
  // Friday 2026-06-26.
  const monMorning = new Date(2026, 5, 29, 9, 0, 0);

  it("fresh when the freshest bar is Friday (the last completed session)", () => {
    expect(isPriceTailStale("2026-06-26", monMorning)).toBe(false);
  });

  it("stale when the freshest bar is only Thursday (Friday missing)", () => {
    expect(isPriceTailStale("2026-06-25", monMorning)).toBe(true);
  });

  it("treats an empty tape (null) as stale", () => {
    expect(isPriceTailStale(null, monMorning)).toBe(true);
  });

  it("fresh when a bar is dated after the last close (e.g. mid-session today)", () => {
    expect(isPriceTailStale("2026-06-29", monMorning)).toBe(false);
  });
});

describe("lastTradingClose", () => {
  it("on Friday at 18:00 returns the same Friday 17:00", () => {
    // Friday 2026-06-12 18:00 local
    const fri = new Date(2026, 5, 12, 18, 0, 0);
    const last = lastTradingClose(fri);
    expect(last.getDay()).toBe(5); // Friday
    expect(last.getDate()).toBe(12);
    expect(last.getHours()).toBe(17);
  });

  it("on Friday at 09:00 (before close) returns Thursday 17:00", () => {
    const fri = new Date(2026, 5, 12, 9, 0, 0);
    const last = lastTradingClose(fri);
    expect(last.getDay()).toBe(4); // Thursday
    expect(last.getDate()).toBe(11);
    expect(last.getHours()).toBe(17);
  });

  it("on Saturday returns the prior Friday 17:00", () => {
    const sat = new Date(2026, 5, 13, 10, 0, 0);
    const last = lastTradingClose(sat);
    expect(last.getDay()).toBe(5); // Friday
    expect(last.getDate()).toBe(12);
    expect(last.getHours()).toBe(17);
  });

  it("on Sunday returns the prior Friday 17:00", () => {
    const sun = new Date(2026, 5, 14, 23, 59, 0);
    const last = lastTradingClose(sun);
    expect(last.getDay()).toBe(5);
    expect(last.getDate()).toBe(12);
  });

  it("on Monday at 16:00 (before close) returns the prior Friday 17:00", () => {
    const mon = new Date(2026, 5, 15, 16, 0, 0);
    const last = lastTradingClose(mon);
    expect(last.getDay()).toBe(5);
    expect(last.getDate()).toBe(12);
  });

  it("on Monday at 17:30 (after close) returns the same Monday 17:00", () => {
    const mon = new Date(2026, 5, 15, 17, 30, 0);
    const last = lastTradingClose(mon);
    expect(last.getDay()).toBe(1);
    expect(last.getDate()).toBe(15);
  });
});

describe("getPrecomputeFreshness", () => {
  const now = new Date(2026, 5, 15, 19, 0, 0); // Mon 19:00 → last close = Mon 17:00
  const lastClose = lastTradingClose(now);

  it("empty cache is stale", async () => {
    const db = makeFakeDb([]);
    const f = await getPrecomputeFreshness(db, "MACRO14", [63, 252, 504, 756], now);
    expect(f.stale).toBe(true);
    expect(f.freshestComputedAt).toBeNull();
    expect(f.latestComputedAt).toBeNull();
    expect(f.oldestAsOfDate).toBeNull();
    expect(f.grids).toHaveLength(0);
  });

  it("all 4 expected windows present and all computed after the close → fresh", async () => {
    const after = new Date(lastClose.getTime() + 60_000);
    const db = makeFakeDb(
      [63, 252, 504, 756].map((w) => ({
        regressionWindow: w,
        asOfDate: new Date("2026-06-15"),
        computedAt: after,
      })),
    );
    const f = await getPrecomputeFreshness(db, "MACRO14", [63, 252, 504, 756], now);
    expect(f.stale).toBe(false);
    expect(f.freshestComputedAt).not.toBeNull();
    expect(f.grids).toHaveLength(4);
  });

  it("any expected window missing → stale even if the present rows are fresh", async () => {
    const after = new Date(lastClose.getTime() + 60_000);
    const db = makeFakeDb(
      [63, 252, 504].map((w) => ({
        regressionWindow: w,
        asOfDate: new Date("2026-06-15"),
        computedAt: after,
      })),
    );
    const f = await getPrecomputeFreshness(db, "MACRO14", [63, 252, 504, 756], now);
    expect(f.stale).toBe(true);
    expect(f.freshestComputedAt).toBeNull();
    expect(f.grids).toHaveLength(3);
  });

  it("oldest computedAt is the limiting factor → stale when even one row is older than the last close", async () => {
    const after = new Date(lastClose.getTime() + 60_000);
    const before = new Date(lastClose.getTime() - 60_000);
    const db = makeFakeDb([
      { regressionWindow: 63, asOfDate: new Date("2026-06-15"), computedAt: after },
      { regressionWindow: 252, asOfDate: new Date("2026-06-15"), computedAt: after },
      { regressionWindow: 504, asOfDate: new Date("2026-06-15"), computedAt: after },
      { regressionWindow: 756, asOfDate: new Date("2026-06-15"), computedAt: before },
    ]);
    const f = await getPrecomputeFreshness(db, "MACRO14", [63, 252, 504, 756], now);
    expect(f.stale).toBe(true);
    expect(new Date(f.freshestComputedAt!).getTime()).toBe(before.getTime());
  });

  it("returns latestComputedAt and oldestAsOfDate sourced from the actual rows", async () => {
    const t1 = new Date(lastClose.getTime() + 60_000);
    const t2 = new Date(lastClose.getTime() + 120_000);
    const db = makeFakeDb([
      {
        regressionWindow: 63,
        asOfDate: new Date("2026-06-10"),
        computedAt: t1,
      },
      {
        regressionWindow: 252,
        asOfDate: new Date("2026-06-15"),
        computedAt: t2,
      },
      {
        regressionWindow: 504,
        asOfDate: new Date("2026-06-12"),
        computedAt: t2,
      },
      {
        regressionWindow: 756,
        asOfDate: new Date("2026-06-14"),
        computedAt: t2,
      },
    ]);
    const f = await getPrecomputeFreshness(db, "MACRO14", [63, 252, 504, 756], now);
    expect(f.latestComputedAt).toBe(t2.toISOString());
    expect(f.oldestAsOfDate).toBe("2026-06-10");
  });
});
