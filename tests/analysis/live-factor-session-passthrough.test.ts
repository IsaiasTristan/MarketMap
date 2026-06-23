/**
 * Regression: live 1D factor row must be available outside REGULAR hours so
 * after-the-close portfolio / per-stock 1D decomposition reflects today's
 * official close (Yahoo regularMarketPrice), not the stale engine slice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { LIVE_FACTOR_ETFS } from "../../src/lib/factors/live/compose-live-factors";
import { getUsMarketSession } from "../../src/lib/market-map/market-session";

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    factorReturnDaily: {
      findFirst: vi.fn(async () => ({ value: 0.00017 })),
    },
  },
}));

vi.mock("@/infrastructure/providers/yahoo-chart-http", () => ({
  toYahooSymbol: (s: string) => s,
  fetchYahooQuotesWithSparkline: vi.fn(async (tickers: string[]) => {
    const out = new Map<string, { price: number; prevClose: number }>();
    for (const t of tickers) {
      out.set(t, { price: 101, prevClose: 100 });
    }
    return out;
  }),
}));

import {
  getLiveFactorRow,
  _resetLiveFactorReturnsCache,
} from "../../src/server/services/live-factor-returns.service";

/** Monday 2026-06-22 22:53 ET — CLOSED (after POST window). */
const MONDAY_AFTER_CLOSE = new Date("2026-06-23T02:53:00.000Z");

describe("getLiveFactorRow — session passthrough", () => {
  beforeEach(() => {
    _resetLiveFactorReturnsCache();
  });

  it("returns a non-null row outside REGULAR hours (CLOSED session)", async () => {
    expect(getUsMarketSession(MONDAY_AFTER_CLOSE)).toBe("CLOSED");

    const row = await getLiveFactorRow(MONDAY_AFTER_CLOSE);
    expect(row).not.toBeNull();
    expect(row!.session).toBe("CLOSED");
    expect(Object.keys(row!.returns).length).toBeGreaterThan(0);
    expect(row!.rf).toBeCloseTo(0.00017, 6);
  });

  it("composes all MACRO14 legs when every ETF quote is present", async () => {
    const row = await getLiveFactorRow(MONDAY_AFTER_CLOSE);
    expect(row).not.toBeNull();
    // Every leg present → no missing ETFs.
    expect(row!.missingLegs).toHaveLength(0);
    expect(LIVE_FACTOR_ETFS.length).toBeGreaterThan(0);
  });
});
