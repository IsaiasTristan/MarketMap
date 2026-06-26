/**
 * VIX settlement-mode strip helpers — CBOE indices settle ~16:10 ET, so the
 * prior close and live price must come from POST-inclusive bar series, not
 * Yahoo meta.previousClose (stale T-2) or the 15:55 regular print.
 */
import { describe, expect, it } from "vitest";
import {
  priorDaySettlementClose,
  todaySettlementSeries,
} from "@/lib/holdings/intraday-split";
import { computeStripQuote } from "@/server/services/market-strip.service";

function etUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Minimal Jun 24–25 ^VIX bar pattern from live Yahoo (Jun 2026). */
function vixJun2425Fixture() {
  const jun24RegOpen = etUnix("2026-06-24T09:30:00-04:00");
  const jun24RegLast = etUnix("2026-06-24T15:55:00-04:00");
  const jun24PostSettle = etUnix("2026-06-24T16:10:00-04:00");
  const jun25RegOpen = etUnix("2026-06-25T09:30:00-04:00");
  const jun25Midday = etUnix("2026-06-25T12:00:00-04:00");
  const jun25RegLast = etUnix("2026-06-25T15:55:00-04:00");
  const jun25PostSettle = etUnix("2026-06-25T16:10:00-04:00");

  const timestamps = [
    jun24RegOpen,
    jun24RegLast,
    jun24PostSettle,
    jun25RegOpen,
    jun25Midday,
    jun25RegLast,
    jun25PostSettle,
  ];
  const closes = [
    18.97, // Jun 24 open
    19.51, // Jun 24 last regular (not the settlement)
    18.65, // Jun 24 POST settlement
    18.07, // Jun 25 open
    18.98, // Jun 25 midday
    19.06, // Jun 25 last regular
    18.9, // Jun 25 POST settlement
  ];
  return { timestamps, closes };
}

describe("priorDaySettlementClose", () => {
  it("returns the prior day's POST settlement, not the 15:55 regular print", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const now = new Date("2026-06-25T12:00:00-04:00");
    expect(priorDaySettlementClose(timestamps, closes, now)).toBeCloseTo(
      18.65,
      2,
    );
  });

  it("does not use Yahoo's stale T-2 meta.previousClose (19.49)", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const now = new Date("2026-06-25T16:15:00-04:00");
    const prev = priorDaySettlementClose(timestamps, closes, now);
    expect(prev).toBeCloseTo(18.65, 2);
    expect(prev).not.toBeCloseTo(19.49, 2);
  });
});

describe("todaySettlementSeries", () => {
  it("uses the latest today bar for livePrice at midday", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const middayIdx = 4; // through Jun 25 12:00 bar only
    const now = new Date("2026-06-25T12:00:00-04:00");
    const { livePrice, regular } = todaySettlementSeries(
      timestamps.slice(0, middayIdx + 1),
      closes.slice(0, middayIdx + 1),
      now,
    );
    expect(livePrice).toBeCloseTo(18.98, 2);
    expect(regular.length).toBeGreaterThanOrEqual(2);
    expect(regular[regular.length - 1]).toBeCloseTo(18.98, 2);
  });

  it("includes POST settlement in livePrice after 16:00", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const now = new Date("2026-06-25T16:15:00-04:00");
    const { livePrice, extended } = todaySettlementSeries(
      timestamps,
      closes,
      now,
    );
    expect(livePrice).toBeCloseTo(18.9, 2);
    expect(extended.length).toBeGreaterThanOrEqual(1);
    expect(extended[extended.length - 1]).toBeCloseTo(18.9, 2);
  });
});

describe("computeStripQuote with settlement baseline", () => {
  it("midday: positive change vs settlement prevClose, not Yahoo stale meta", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const middayIdx = 4;
    const now = new Date("2026-06-25T12:00:00-04:00");
    const ts = timestamps.slice(0, middayIdx + 1);
    const cs = closes.slice(0, middayIdx + 1);
    const prevClose = priorDaySettlementClose(ts, cs, now);
    const { livePrice } = todaySettlementSeries(ts, cs, now);
    const q = computeStripQuote(livePrice, prevClose, "price");
    expect(q.change).toBeCloseTo(0.33, 2);
    expect(q.changePct).toBeCloseTo(0.33 / 18.65, 3);
    expect((q.changePct ?? 0) >= 0).toBe(true);
  });

  it("end-of-day: positive change vs settlement prevClose", () => {
    const { timestamps, closes } = vixJun2425Fixture();
    const now = new Date("2026-06-25T16:15:00-04:00");
    const prevClose = priorDaySettlementClose(timestamps, closes, now);
    const { livePrice } = todaySettlementSeries(timestamps, closes, now);
    const q = computeStripQuote(livePrice, prevClose, "price");
    expect(q.change).toBeCloseTo(0.25, 2);
    expect(q.changePct).toBeCloseTo(0.25 / 18.65, 3);
    expect((q.changePct ?? 0) >= 0).toBe(true);
  });

  it("would show wrong sign if Yahoo stale prevClose (19.49) were used", () => {
    const { livePrice } = todaySettlementSeries(
      vixJun2425Fixture().timestamps,
      vixJun2425Fixture().closes,
      new Date("2026-06-25T16:15:00-04:00"),
    );
    const wrong = computeStripQuote(livePrice, 19.49, "price");
    expect((wrong.changePct ?? 0) < 0).toBe(true);
  });
});
