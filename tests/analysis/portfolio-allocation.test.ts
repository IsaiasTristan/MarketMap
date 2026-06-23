/**
 * Tests for the Capital Allocation donut's Return / Risk dimensions and the
 * sector-resolution priority chain.
 *
 * Pure helpers (`scaleVarToHorizon`, `horizonStartDateIso`, `resolveSector`,
 * `getAllocationBySector`) are exercised directly. `getReturnRiskAllocation`
 * is hit as an integration test with mocked prisma + risk.service to pin the
 * sign-adjusted return for shorts, the |value| + negative-flag composition,
 * and the sqrt-time VaR scaling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the prisma client. Filled per-test before invoking
// `getReturnRiskAllocation`.
type StoredPrice = { adjClose: number; tradeDate: Date };

const dbStore: {
  portfolioPositions: Array<{
    securityId: string;
    shares: number;
    isShort: boolean;
    security: { ticker: string; name: string };
  }>;
  prices: Map<string, StoredPrice[]>;
} = {
  portfolioPositions: [],
  prices: new Map(),
};

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    portfolioPosition: {
      findMany: vi.fn(async () => dbStore.portfolioPositions),
    },
    priceHistory: {
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { securityId: string; tradeDate?: { lte: Date } };
          orderBy?: { tradeDate: "asc" | "desc" };
        }) => {
          const rows = dbStore.prices.get(where.securityId) ?? [];
          const filtered = where.tradeDate?.lte
            ? rows.filter((r) => r.tradeDate <= where.tradeDate!.lte)
            : rows;
          const sorted = [...filtered].sort(
            (a, b) =>
              (orderBy?.tradeDate === "asc" ? 1 : -1) *
              (a.tradeDate.getTime() - b.tradeDate.getTime()),
          );
          return sorted[0] ?? null;
        },
      ),
    },
    // Unused by the integration test but the pnl module references these on
    // its broader code paths; stubbing avoids breaking the module import.
    security: { findMany: vi.fn(async () => []) },
    universeConstituent: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/infrastructure/providers/yahoo-chart-http", () => ({
  toYahooSymbol: (s: string) => s,
  fetchYahooQuotesViaChart: vi.fn(async () => new Map()),
}));

// Risk service is mocked so the test pins exactly which 1-day VaR each
// position contributes before sqrt-time scaling kicks in.
const mockPositionRisks = {
  positions: [
    { ticker: "LONG", varDollar95: 100 },
    { ticker: "SHRT", varDollar95: 50 },
  ],
  portfolioValue: 0,
};

vi.mock("../../src/server/services/risk.service", () => ({
  computePositionRisk: vi.fn(async () => mockPositionRisks),
}));

// imports must come after vi.mock() calls
import {
  scaleVarToHorizon,
  horizonStartDateIso,
  resolveSector,
  getAllocationBySector,
  getReturnRiskAllocation,
  type PositionWithPnl,
} from "../../src/server/services/pnl.service";

beforeEach(() => {
  dbStore.portfolioPositions = [];
  dbStore.prices = new Map();
});

describe("scaleVarToHorizon (sqrt-time VaR scaling)", () => {
  it("1D is the identity", () => {
    expect(scaleVarToHorizon(100, "1D")).toBe(100);
  });

  it("5D scales by sqrt(5)", () => {
    expect(scaleVarToHorizon(100, "5D")).toBeCloseTo(100 * Math.sqrt(5), 9);
  });

  it("1Y scales by sqrt(252)", () => {
    expect(scaleVarToHorizon(100, "1Y")).toBeCloseTo(100 * Math.sqrt(252), 9);
  });

  it("5Y scales by sqrt(1260)", () => {
    expect(scaleVarToHorizon(100, "5Y")).toBeCloseTo(100 * Math.sqrt(1260), 9);
  });

  it("zero-VaR positions stay at zero on every horizon", () => {
    expect(scaleVarToHorizon(0, "1D")).toBe(0);
    expect(scaleVarToHorizon(0, "1Y")).toBe(0);
  });
});

describe("horizonStartDateIso (calendar offsets)", () => {
  const ref = new Date("2026-06-21T00:00:00Z");

  it("1D = yesterday (UTC)", () => {
    expect(horizonStartDateIso("1D", ref)).toBe("2026-06-20");
  });

  it("5D = 7 calendar days back (covers a weekend)", () => {
    expect(horizonStartDateIso("5D", ref)).toBe("2026-06-14");
  });

  it("1M = 30 calendar days back", () => {
    expect(horizonStartDateIso("1M", ref)).toBe("2026-05-22");
  });

  it("1Y = 365 calendar days back", () => {
    expect(horizonStartDateIso("1Y", ref)).toBe("2025-06-21");
  });

  it("5Y = 1825 calendar days back", () => {
    expect(horizonStartDateIso("5Y", ref)).toBe("2021-06-22");
  });
});

describe("resolveSector (universe tag wins)", () => {
  it("prefers the universe-tag sector over position override and security profile", () => {
    expect(resolveSector("Materials", "Technology", "Industrials")).toBe(
      "Materials",
    );
  });

  it("falls through to position override when no universe tag exists", () => {
    expect(resolveSector(null, "Technology", "Industrials")).toBe("Technology");
  });

  it("falls through to security profile when neither override exists", () => {
    expect(resolveSector(null, null, "Industrials")).toBe("Industrials");
  });

  it("returns null when no source provides a sector", () => {
    expect(resolveSector(null, null, null)).toBeNull();
    expect(resolveSector(undefined, undefined, undefined)).toBeNull();
  });
});

describe("getAllocationBySector (grouping)", () => {
  const mk = (
    ticker: string,
    sector: string | null,
    mv: number,
  ): PositionWithPnl => ({
    ticker,
    name: ticker,
    sector,
    country: null,
    shares: 1,
    isShort: false,
    currentPrice: mv,
    marketValue: mv,
    dailyPnl: 0,
    dailyPnlPct: 0,
    weight: 0,
    adv20d: 0,
    daysToLiquidate: 0,
  });

  it("aggregates by sector with pct that sums to 1", () => {
    const result = getAllocationBySector([
      mk("AAPL", "Technology", 300),
      mk("MSFT", "Technology", 200),
      mk("JPM", "Financials", 500),
    ]);
    const byName = new Map(result.map((s) => [s.name, s]));
    expect(byName.get("Technology")?.value).toBe(500);
    expect(byName.get("Financials")?.value).toBe(500);
    expect(byName.get("Technology")?.pct).toBeCloseTo(0.5, 12);
    expect(byName.get("Financials")?.pct).toBeCloseTo(0.5, 12);
    const sumPct = result.reduce((s, x) => s + x.pct, 0);
    expect(sumPct).toBeCloseTo(1, 12);
  });

  it("buckets null sectors under 'Other' so they remain visible", () => {
    const result = getAllocationBySector([
      mk("X", null, 100),
      mk("Y", null, 50),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Other");
    expect(result[0].value).toBe(150);
  });
});

describe("getReturnRiskAllocation (integration with mocked DB / risk)", () => {
  it("signs returns correctly for longs and shorts; sizes slices by |return%|", async () => {
    // Long: price moves 100 -> 110 over the horizon  => +10%
    // Short: price moves 50 -> 60 over the horizon   => SHORT lost  => -20%
    // Start = clearly older than any horizon cutoff `new Date()` produces;
    // end = far future so the latest-price lookup always wins regardless of
    // when the test runs.
    const start = new Date("2010-01-01");
    const end = new Date("2099-01-01");
    dbStore.portfolioPositions = [
      {
        securityId: "long-id",
        shares: 10,
        isShort: false,
        security: { ticker: "LONG", name: "Long Co" },
      },
      {
        securityId: "shrt-id",
        shares: 5,
        isShort: true,
        security: { ticker: "SHRT", name: "Short Co" },
      },
    ];
    dbStore.prices.set("long-id", [
      { adjClose: 100, tradeDate: start },
      { adjClose: 110, tradeDate: end },
    ]);
    dbStore.prices.set("shrt-id", [
      { adjClose: 50, tradeDate: start },
      { adjClose: 60, tradeDate: end },
    ]);

    const result = await getReturnRiskAllocation("p1", "1Y");

    const long = result.byReturn.find((s) => s.name === "LONG")!;
    const shrt = result.byReturn.find((s) => s.name === "SHRT")!;

    // LONG: +10% return, positive slice
    expect(long.signed).toBeCloseTo(0.1, 9);
    expect(long.value).toBeCloseTo(0.1, 9);
    expect(long.negative).toBe(false);

    // SHRT (short with price up): -20% return, negative slice, |value| sized
    expect(shrt.signed).toBeCloseTo(-0.2, 9);
    expect(shrt.value).toBeCloseTo(0.2, 9);
    expect(shrt.negative).toBe(true);

    // Gross-weighted total return = (long P&L + short P&L) / gross MV
    // long P&L = +100, short P&L = -50, gross MV = 1100 + 300 = 1400
    // returnPct = 50 / 1400 = 0.03571...
    expect(result.totals.returnDollar).toBeCloseTo(50, 9);
    expect(result.totals.grossValue).toBeCloseTo(1400, 9);
    expect(result.totals.returnPct).toBeCloseTo(50 / 1400, 9);
  });

  it("scales 1-day position VaR by sqrt(trading days) for non-1D horizons", async () => {
    const start = new Date("2010-01-01");
    const end = new Date("2099-01-01");
    dbStore.portfolioPositions = [
      {
        securityId: "long-id",
        shares: 10,
        isShort: false,
        security: { ticker: "LONG", name: "Long Co" },
      },
      {
        securityId: "shrt-id",
        shares: 5,
        isShort: true,
        security: { ticker: "SHRT", name: "Short Co" },
      },
    ];
    dbStore.prices.set("long-id", [
      { adjClose: 100, tradeDate: start },
      { adjClose: 110, tradeDate: end },
    ]);
    dbStore.prices.set("shrt-id", [
      { adjClose: 50, tradeDate: start },
      { adjClose: 60, tradeDate: end },
    ]);

    const result = await getReturnRiskAllocation("p1", "1Y");
    const scale = Math.sqrt(252);

    const long = result.byRisk.find((s) => s.name === "LONG")!;
    const shrt = result.byRisk.find((s) => s.name === "SHRT")!;
    // Mocked 1D VaR: LONG=100, SHRT=50 (see vi.mock above)
    expect(long.dollar).toBeCloseTo(100 * scale, 6);
    expect(shrt.dollar).toBeCloseTo(50 * scale, 6);

    // pcts sum to 1 and are share of total horizon VaR
    const sumPct = result.byRisk.reduce((s, r) => s + r.pct, 0);
    expect(sumPct).toBeCloseTo(1, 9);
    expect(long.pct).toBeCloseTo(100 / 150, 9);
    expect(shrt.pct).toBeCloseTo(50 / 150, 9);

    // Risk slices are never marked negative — shorts add to risk too
    expect(long.negative).toBe(false);
    expect(shrt.negative).toBe(false);

    // Total VaR over horizon and varPct (vs gross capital)
    expect(result.totals.varDollar).toBeCloseTo(150 * scale, 6);
    expect(result.totals.varPct).toBeCloseTo((150 * scale) / 1400, 6);
  });

  it("returns an empty result with zeroed totals when the portfolio has no positions", async () => {
    dbStore.portfolioPositions = [];
    const result = await getReturnRiskAllocation("p-empty", "1D");
    expect(result.byReturn).toEqual([]);
    expect(result.byRisk).toEqual([]);
    expect(result.totals).toEqual({
      returnPct: 0,
      returnDollar: 0,
      varDollar: 0,
      varPct: 0,
      grossValue: 0,
    });
  });
});
