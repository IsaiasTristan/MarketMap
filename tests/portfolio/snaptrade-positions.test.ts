import { describe, it, expect } from "vitest";
import { mapSnapTradePositions } from "@/lib/brokerage/snaptrade-positions";
import type {
  SnapTradeBalance,
  SnapTradePosition,
} from "@/infrastructure/providers/snaptrade/types";

function pos(p: Partial<SnapTradePosition>): SnapTradePosition {
  return {
    kind: "stock",
    symbol: "AAPL",
    units: "10",
    cashEquivalent: false,
    currency: "USD",
    ...p,
  };
}

const noBalances: SnapTradeBalance[] = [];

describe("mapSnapTradePositions", () => {
  it("maps a long equity position to shares with isShort=false", () => {
    const r = mapSnapTradePositions([pos({ symbol: "aapl", units: "10" })], noBalances);
    expect(r.equities).toEqual([{ ticker: "AAPL", shares: 10, isShort: false }]);
    expect(r.skipped).toHaveLength(0);
  });

  it("treats negative units as a short position", () => {
    const r = mapSnapTradePositions([pos({ symbol: "TSLA", units: "-4" })], noBalances);
    expect(r.equities).toEqual([{ ticker: "TSLA", shares: 4, isShort: true }]);
  });

  it("drops zero-unit and non-finite positions", () => {
    const r = mapSnapTradePositions(
      [pos({ symbol: "A", units: "0" }), pos({ symbol: "B", units: null })],
      noBalances,
    );
    expect(r.equities).toHaveLength(0);
  });

  it("aggregates duplicate tickers on signed units", () => {
    const r = mapSnapTradePositions(
      [pos({ symbol: "MSFT", units: "5" }), pos({ symbol: "MSFT", units: "3" })],
      noBalances,
    );
    expect(r.equities).toEqual([{ ticker: "MSFT", shares: 8, isShort: false }]);
  });

  it("nets a long and short of the same ticker and drops a flat result", () => {
    const r = mapSnapTradePositions(
      [pos({ symbol: "NVDA", units: "5" }), pos({ symbol: "NVDA", units: "-5" })],
      noBalances,
    );
    expect(r.equities).toHaveLength(0);
  });

  it("keeps ETF, ADR and CEF but skips options/crypto/futures", () => {
    const r = mapSnapTradePositions(
      [
        pos({ kind: "etf", symbol: "SPY", units: "2" }),
        pos({ kind: "adr", symbol: "BABA", units: "1" }),
        pos({ kind: "cef", symbol: "PDI", units: "7" }),
        pos({ kind: "option", symbol: "AAPL240119C", units: "1" }),
        pos({ kind: "crypto", symbol: "BTC", units: "0.5" }),
        pos({ kind: "future", symbol: "ESZ4", units: "1" }),
      ],
      noBalances,
    );
    expect(r.equities.map((e) => e.ticker).sort()).toEqual(["BABA", "PDI", "SPY"]);
    expect(r.skipped.map((s) => s.kind).sort()).toEqual(["crypto", "future", "option"]);
  });

  it("folds cash from balances and drops cash-equivalent positions without double-counting", () => {
    const r = mapSnapTradePositions(
      [
        pos({ symbol: "AAPL", units: "10" }),
        pos({ kind: "mutualfund", symbol: "VMFXX", units: "5000", cashEquivalent: true }),
      ],
      [
        { currency: "USD", cash: 4200.5 },
        { currency: "USD", cash: 100 },
      ],
    );
    expect(r.equities).toEqual([{ ticker: "AAPL", shares: 10, isShort: false }]);
    expect(r.cash).toBe(4300.5);
    // The cash-equivalent fund is neither an equity nor a surfaced skip.
    expect(r.skipped).toHaveLength(0);
  });

  it("returns null cash when no balance rows carry a numeric cash figure", () => {
    const r = mapSnapTradePositions([pos({ units: "1" })], [{ currency: "USD", cash: null }]);
    expect(r.cash).toBeNull();
  });

  it("skips an equity with a missing symbol", () => {
    const r = mapSnapTradePositions([pos({ symbol: "  ", units: "3" })], noBalances);
    expect(r.equities).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ reason: "missing ticker symbol" });
  });
});
