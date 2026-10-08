import { describe, it, expect } from "vitest";
import {
  normalizeActivityType,
  classifyActivity,
  replayHoldingsBackward,
  buildDailyNav,
  openingPositionValue,
  detectSplitFactors,
  type ReplayActivity,
} from "@/lib/portfolio/holdings-replay";

describe("normalizeActivityType", () => {
  it("maps the live Robinhood-via-SnapTrade raw types", () => {
    expect(normalizeActivityType("BUY")).toBe("BUY");
    expect(normalizeActivityType("SELL")).toBe("SELL");
    expect(normalizeActivityType("DIVIDEND")).toBe("DIVIDEND");
    expect(normalizeActivityType("SUBSTITUTE_DIVIDEND")).toBe("DIVIDEND");
    expect(normalizeActivityType("REI")).toBe("REINVEST");
    expect(normalizeActivityType("CONTRIBUTION")).toBe("CONTRIBUTION");
    expect(normalizeActivityType("FEE")).toBe("FEE");
    expect(normalizeActivityType("EXTERNAL_ASSET_TRANSFER_IN")).toBe("TRANSFER_IN");
    expect(normalizeActivityType("TRANSFER")).toBe("CASH_TRANSFER");
  });
  it("falls back to OTHER for unknown types (case-insensitive)", () => {
    expect(normalizeActivityType("optionexpiration")).toBe("OTHER");
    expect(normalizeActivityType("")).toBe("OTHER");
    expect(normalizeActivityType(null)).toBe("OTHER");
  });
});

describe("classifyActivity", () => {
  const base = (o: Partial<ReplayActivity>): ReplayActivity => ({
    date: "2026-08-10",
    activityType: "BUY",
    ticker: "AAPL",
    units: null,
    amount: null,
    ...o,
  });

  it("a BUY moves shares up and cash down; no external flow", () => {
    const e = classifyActivity(base({ activityType: "BUY", units: 10, amount: -1500 }));
    expect(e.unitsDelta).toBe(10);
    expect(e.cashDelta).toBe(-1500);
    expect(e.externalCashFlow).toBe(0);
    expect(e.externalShareUnits).toBe(0);
  });

  it("a SELL uses the already-signed negative units", () => {
    const e = classifyActivity(base({ activityType: "SELL", units: -4, amount: 620 }));
    expect(e.unitsDelta).toBe(-4);
    expect(e.cashDelta).toBe(620);
    expect(e.externalCashFlow).toBe(0);
  });

  it("a DIVIDEND is cash income, not an external flow", () => {
    const e = classifyActivity(base({ activityType: "DIVIDEND", ticker: "NOC", units: 0, amount: 13.51 }));
    expect(e.cashDelta).toBeCloseTo(13.51);
    expect(e.externalCashFlow).toBe(0);
  });

  it("a CONTRIBUTION is a pure external cash flow", () => {
    const e = classifyActivity(base({ activityType: "CONTRIBUTION", ticker: null, units: 0, amount: 500 }));
    expect(e.cashDelta).toBe(500);
    expect(e.externalCashFlow).toBe(500);
  });

  it("a share TRANSFER_IN carries external share units and no cash", () => {
    const e = classifyActivity(base({ activityType: "TRANSFER_IN", ticker: "CNP", units: 109, amount: 0 }));
    expect(e.unitsDelta).toBe(109);
    expect(e.externalShareUnits).toBe(109);
    expect(e.externalCashFlow).toBe(0);
  });

  it("an option row moves cash via premium but never touches equity shares", () => {
    const e = classifyActivity(base({ activityType: "SELL", ticker: "USO", units: -1, amount: 250, isOption: true }));
    expect(e.unitsDelta).toBe(0); // contracts are not shares
    expect(e.cashDelta).toBe(250);
    expect(e.valuable).toBe(false);
  });
});

describe("replayHoldingsBackward", () => {
  it("reconstructs the opening position and ties forward to today's balances", () => {
    // Start empty, transfer in 100 AAPL, buy 10 more, sell 5, end with 105.
    const activities: ReplayActivity[] = [
      { date: "2026-08-06", activityType: "TRANSFER_IN", ticker: "AAPL", units: 100, amount: 0 },
      { date: "2026-08-10", activityType: "BUY", ticker: "AAPL", units: 10, amount: -1500 },
      { date: "2026-08-20", activityType: "SELL", ticker: "AAPL", units: -5, amount: 800 },
    ];
    const currentShares = { AAPL: 105 };
    const currentCash = -700; // -1500 + 800, opening cash 0
    const r = replayHoldingsBackward(currentShares, currentCash, activities);

    expect(r.openingShares.AAPL).toBe(0);
    expect(r.openingCash).toBeCloseTo(0);
    // End-of-day snapshots roll forward correctly.
    expect(r.snapshots[0]).toMatchObject({ date: "2026-08-06", shares: { AAPL: 100 } });
    expect(r.snapshots[1].shares.AAPL).toBe(110);
    expect(r.snapshots[2].shares.AAPL).toBe(105);
    // External flow only on the transfer-in date.
    const flow = Object.fromEntries(r.externalFlows.map((f) => [f.date, f]));
    expect(flow["2026-08-06"].shareUnits.AAPL).toBe(100);
    expect(flow["2026-08-10"]).toBeUndefined();
  });

  it("derives a non-zero opening position when history predates the ledger", () => {
    // Today holds 50 shares but the only activity is a +10 buy — so 40 shares
    // must have existed before the earliest activity (the opening position).
    const activities: ReplayActivity[] = [
      { date: "2026-08-10", activityType: "BUY", ticker: "MSFT", units: 10, amount: -3000 },
    ];
    const r = replayHoldingsBackward({ MSFT: 50 }, 0, activities);
    expect(r.openingShares.MSFT).toBe(40);
  });

  it("snaps fractional dust to zero", () => {
    const r = replayHoldingsBackward({ X: 1e-9 }, 0, []);
    expect(r.openingShares.X).toBe(0);
  });
});

describe("buildDailyNav + openingPositionValue", () => {
  const activities: ReplayActivity[] = [
    { date: "2026-08-06", activityType: "TRANSFER_IN", ticker: "AAPL", units: 100, amount: 0 },
    { date: "2026-08-07", activityType: "CONTRIBUTION", ticker: null, units: 0, amount: 1000 },
  ];
  // Today: 100 AAPL + 1000 cash.
  const replay = replayHoldingsBackward({ AAPL: 100 }, 1000, activities);
  const prices: Record<string, Record<string, number>> = {
    AAPL: { "2026-08-06": 200, "2026-08-07": 210 },
  };
  const priceOf = (t: string, d: string) => prices[t]?.[d] ?? null;

  it("values NAV on unadjusted close and folds opening into the first flow", () => {
    const { navByDate, flowByDate, dates } = buildDailyNav(replay, ["2026-08-06", "2026-08-07"], priceOf);
    expect(dates).toEqual(["2026-08-06", "2026-08-07"]);
    // Day 0: 100 × 200 = 20,000 (no cash yet).
    expect(navByDate[0]).toBe(20000);
    // Day 1: 100 × 210 + 1000 cash = 22,000.
    expect(navByDate[1]).toBe(22000);
    // Day 0 flow = transfer-in value (100×200) + opening (0) = 20,000.
    expect(flowByDate[0]).toBe(20000);
    // Day 1 flow = contribution 1000.
    expect(flowByDate[1]).toBe(1000);
  });

  it("openingPositionValue is zero when the account funded via the ledger", () => {
    expect(openingPositionValue(replay, "2026-08-06", priceOf)).toBe(0);
  });
});

describe("detectSplitFactors", () => {
  it("recovers a 2:1 split from diverging raw vs adjusted close", () => {
    // Raw close halves on the split day; adjusted close only moves ~flat.
    const series = [
      { date: "2026-08-10", close: 400, adjClose: 200 },
      { date: "2026-08-11", close: 200, adjClose: 200 }, // 2:1 split
      { date: "2026-08-12", close: 202, adjClose: 202 },
    ];
    const events = detectSplitFactors(series);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ date: "2026-08-11", factor: 2 });
  });

  it("does not flag ordinary market moves as splits", () => {
    const series = [
      { date: "2026-08-10", close: 100, adjClose: 100 },
      { date: "2026-08-11", close: 103, adjClose: 103 },
      { date: "2026-08-12", close: 98, adjClose: 98 },
    ];
    expect(detectSplitFactors(series)).toHaveLength(0);
  });
});
