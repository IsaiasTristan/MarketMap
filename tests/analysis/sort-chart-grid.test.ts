import { describe, expect, it } from "vitest";
import {
  sortByAbsDollarDesc,
  sortHoldingsByAbsDailyMove,
} from "@/lib/holdings/sort-chart-grid";
import type { HoldingRow } from "@/server/services/portfolio-holdings.service";

function row(
  ticker: string,
  shares: number,
  price: number,
  prevClose: number,
  isShort = false,
): HoldingRow {
  return {
    ticker,
    name: ticker,
    shares,
    isShort,
    currentPrice: price,
    marketValue: Math.abs(shares * price),
    sparkline: [prevClose, price],
    prevDaySparkline: [],
    sparklineExtended: [],
    intradayPoints: [],
    prevClose,
    dayOpen: prevClose,
    dayLow: prevClose,
    dayHigh: price,
    sector: null,
    subTheme: null,
    chg1dPct: (price - prevClose) / prevClose,
    chg5dPct: 0,
    chgMtdPct: 0,
    chgQtdPct: 0,
    chgYtdPct: 0,
    sectorPctile: null,
    subThemePctile: null,
    sectorDist: [],
    subThemeDist: [],
  };
}

describe("sortHoldingsByAbsDailyMove", () => {
  it("orders by absolute daily dollar P&L descending", () => {
    const rows = [
      row("SMALL", 10, 101, 100), // +10
      row("BIG", 100, 102, 100), // +200
      row("LOSS", 50, 98, 100), // -100
    ];
    const pnlMap = new Map([
      ["SMALL", 10],
      ["BIG", 200],
      ["LOSS", -100],
    ]);
    const sorted = sortHoldingsByAbsDailyMove(rows, pnlMap);
    expect(sorted.map((r) => r.ticker)).toEqual(["BIG", "LOSS", "SMALL"]);
    expect(sorted[0]!.absDailyMove).toBe(200);
    expect(sorted[1]!.absDailyMove).toBe(100);
  });

  it("falls back to shares × price change when P&L map missing", () => {
    const rows = [row("A", 20, 105, 100)];
    const sorted = sortHoldingsByAbsDailyMove(rows, new Map());
    expect(sorted[0]!.absDailyMove).toBe(100);
  });

  it("applies short sign in fallback", () => {
    const rows = [row("S", 10, 110, 100, true)]; // short loses when price rises
    const sorted = sortHoldingsByAbsDailyMove(rows, new Map());
    expect(sorted[0]!.absDailyMove).toBe(100);
  });
});

describe("sortByAbsDollarDesc", () => {
  it("orders by absolute dollar descending regardless of sign", () => {
    const items = [
      { ticker: "SMALL", dailyPnl: 10 },
      { ticker: "BIG", dailyPnl: 200 },
      { ticker: "LOSS", dailyPnl: -500 },
    ];
    const sorted = sortByAbsDollarDesc(items, (i) => i.dailyPnl);
    expect(sorted.map((i) => i.ticker)).toEqual(["LOSS", "BIG", "SMALL"]);
  });

  it("does not mutate the input array", () => {
    const items = [{ v: -1 }, { v: 2 }];
    const copy = [...items];
    sortByAbsDollarDesc(items, (i) => i.v);
    expect(items).toEqual(copy);
  });
});
