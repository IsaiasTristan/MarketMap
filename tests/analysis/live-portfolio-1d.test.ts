/**
 * Live portfolio 1D — engine cache, build path, and period-summary merge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LIVE_FACTOR_ETFS } from "../../src/lib/factors/live/compose-live-factors";
import { getUsMarketSession } from "../../src/lib/market-map/market-session";
import { todayEtIsoDate } from "../../src/lib/factors/attribution/today-et";
import {
  mergeLive1DPeriodSummary,
  pickPeriodSummary,
  type PortfolioLive1DResponse,
} from "../../src/lib/factors/attribution/pick-period-summary";
import type { AttributionResult, FactorCode } from "../../src/types/factors";

const MONDAY_AFTER_CLOSE = new Date("2026-06-23T02:53:00.000Z");
const MOCK_ASOF = "2026-06-23T02:53:00.000Z";

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    factorReturnDaily: {
      findFirst: vi.fn(async () => ({ value: 0.00017 })),
    },
    portfolioPosition: {
      findMany: vi.fn(async () => [
        {
          id: "p1",
          securityId: "s1",
          shares: 100,
          isShort: false,
          sector: null,
          security: { ticker: "AAPL", name: "Apple", sector: "Tech" },
        },
      ]),
    },
    priceHistory: {
      findFirst: vi.fn(async () => ({ adjClose: 500 })),
    },
  },
}));

vi.mock("@/infrastructure/providers/yahoo-chart-http", () => ({
  toYahooSymbol: (s: string) => s,
  fetchYahooQuotesWithSparkline: vi.fn(async (tickers: string[]) => {
    const out = new Map<string, { price: number; prevClose: number }>();
    for (const t of tickers) {
      out.set(t, { price: 104, prevClose: 100 });
    }
    for (const t of LIVE_FACTOR_ETFS) {
      out.set(t, { price: 101, prevClose: 100 });
    }
    return out;
  }),
}));

vi.mock("../../src/server/services/live-factor-returns.service", () => ({
  getLiveFactorRow: vi.fn(async () => ({
    asOf: MOCK_ASOF,
    returns: { EQ: 0.01, MOM: 0.005 },
    rf: 0.00017,
    missingLegs: [],
    session: "CLOSED",
  })),
}));

vi.mock("../../src/server/services/factor-engine.service", () => ({
  runFactorEngine: vi.fn(async () => ({
    rollingFits: [{}],
    factors: ["EQ", "MOM"],
    endFit: {
      betas: [1.0, 0.5],
      alpha: 0.001,
    },
    endFitLog: {
      betas: [0.9, 0.4],
      alpha: 0.0008,
    },
  })),
}));

import {
  buildLivePortfolio1D,
  computeLivePortfolio1D,
  _resetLivePortfolioEngineCache,
} from "../../src/server/services/live-portfolio-1d.service";

const mockEndFit = {
  factorCodes: ["EQ", "MOM"] as FactorCode[],
  endFitBetas: [1.0, 0.5],
  endFitDailyAlpha: 0.001,
  endFitLogBetas: [0.9, 0.4] as number[],
  endFitLogDailyAlpha: 0.0008,
};

describe("todayEtIsoDate", () => {
  it("returns ET calendar date not UTC midnight drift", () => {
    expect(todayEtIsoDate(MONDAY_AFTER_CLOSE)).toBe("2026-06-22");
  });
});

describe("buildLivePortfolio1D — after close", () => {
  it("returns live 1D with today's ET dates outside REGULAR", async () => {
    expect(getUsMarketSession(MONDAY_AFTER_CLOSE)).toBe("CLOSED");

    const result = await buildLivePortfolio1D({
      portfolioId: "port-1",
      ...mockEndFit,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live1D.session).toBe("CLOSED");
    expect(result.summary.startDate).toBe(todayEtIsoDate());
    expect(result.summary.endDate).toBe(todayEtIsoDate());
    expect(result.summary.totalReturn).toBeCloseTo(0.04, 4);
  });
});

describe("computeLivePortfolio1D — cached engine", () => {
  beforeEach(() => {
    _resetLivePortfolioEngineCache();
  });

  it("succeeds via engine cache on CLOSED session", async () => {
    const result = await computeLivePortfolio1D("port-1", "MACRO14", 252);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.label).toBe("1D");
    expect(result.live1D.factorsUsed.length).toBeGreaterThan(0);
  });
});

describe("mergeLive1DPeriodSummary", () => {
  const staleAttribution = {
    periods: [
      {
        label: "1D",
        startDate: "2026-06-18",
        endDate: "2026-06-18",
        totalReturn: 0.0301,
        factorReturn: 0.02,
        rfReturn: 0.00017,
        alpha: 0.001,
        byFactor: [
          { code: "EQ" as FactorCode, label: "Global Equity", contribution: 0.01, pct: 0.3 },
        ],
      },
    ],
    periodsLog: [
      {
        label: "1D",
        startDate: "2026-06-18",
        endDate: "2026-06-18",
        totalLogReturn: 0.029,
        totalGeometricReturn: 0.0294,
        factorLogReturn: 0.018,
        rfLogReturn: 0.00017,
        alpha: 0.0008,
        byFactor: [
          { code: "EQ" as FactorCode, label: "Global Equity", contribution: 0.009, pct: 0.3 },
        ],
      },
    ],
  } as AttributionResult;

  const live: PortfolioLive1DResponse = {
    live: true,
    summary: {
      label: "1D",
      startDate: "2026-06-22",
      endDate: "2026-06-22",
      totalReturn: 0.04,
      factorReturn: 0.03,
      rfReturn: 0.00017,
      alpha: 0.001,
      byFactor: [
        { code: "EQ", label: "Global Equity", contribution: 0.02, pct: 0.5 },
      ],
    },
    summaryLog: {
      label: "1D",
      startDate: "2026-06-22",
      endDate: "2026-06-22",
      totalLogReturn: 0.039,
      totalGeometricReturn: 0.0398,
      factorLogReturn: 0.028,
      rfLogReturn: 0.00017,
      alpha: 0.0008,
      byFactor: [
        { code: "EQ", label: "Global Equity", contribution: 0.018, pct: 0.46 },
      ],
    },
    live1D: {
      asOf: MOCK_ASOF,
      session: "CLOSED",
      missingLegs: [],
      factorsUsed: ["EQ"],
      missingHoldings: [],
    },
  };

  it("overrides stale static 1D with live poll in log mode", () => {
    const base = pickPeriodSummary(staleAttribution, "1D", "log");
    expect(base?.endDate).toBe("2026-06-18");
    expect(base?.totalReturn).toBeCloseTo(0.0294, 4);

    const merged = mergeLive1DPeriodSummary(base, "1D", "log", live);
    expect(merged?.endDate).toBe("2026-06-22");
    expect(merged?.totalReturn).toBeCloseTo(0.0398, 4);
    expect(merged?.isLog).toBe(true);
  });

  it("leaves non-1D periods unchanged", () => {
    const base = pickPeriodSummary(staleAttribution, "1Y", "log");
    const merged = mergeLive1DPeriodSummary(base, "1Y", "log", live);
    expect(merged).toBe(base);
  });
});
