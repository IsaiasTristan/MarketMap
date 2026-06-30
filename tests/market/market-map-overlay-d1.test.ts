/**
 * Tests for the market-map D1 overlay fallback + grid health diagnostics.
 *
 * Regression guard for the "blank cell" bug: under an applied after-hours
 * overlay, a stock with NO genuine after-hours print must fall back to its
 * regular close-to-close 1D move (tagged `d1Source: "REGULAR"`) instead of
 * being blanked, while a stock WITH an AH print uses the AH move
 * (`d1Source: "AH"`). Also pins the diagnostics counters that drive the
 * data-gap chip + ops logging.
 *
 * `computeMarketMap` takes the Prisma client as a parameter, so we feed it a
 * minimal in-memory fake instead of mocking modules.
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { computeMarketMap } from "../../src/server/services/market-map.service";
import type { ExtendedTickerQuote } from "../../src/server/services/extended-hours.service";

type FakeConstituent = {
  securityId: string;
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
};

type Bar = { date: string; adjClose: number };

/** 10 consecutive daily bars 100..109 ending 2026-06-24 (fixed, deterministic). */
function risingSeries(): Bar[] {
  const start = Date.parse("2026-06-15T00:00:00Z");
  return Array.from({ length: 10 }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    adjClose: 100 + i,
  }));
}

function fakeDb(
  constituents: FakeConstituent[],
  prices: Record<string, Bar[]>,
): PrismaClient {
  return {
    universeConstituent: {
      findMany: async () =>
        constituents.map((c, i) => ({
          securityId: c.securityId,
          sector: c.sector,
          subTheme: c.subTheme,
          sortOrder: i,
          security: { ticker: c.ticker, name: c.name, isActive: true },
        })),
    },
    benchmark: { findUnique: async () => null },
    benchmarkPriceHistory: { findMany: async () => [] },
    priceHistory: {
      findMany: async () => {
        const rows: { securityId: string; tradeDate: Date; adjClose: number }[] =
          [];
        for (const [securityId, series] of Object.entries(prices)) {
          for (const b of series) {
            rows.push({
              securityId,
              tradeDate: new Date(`${b.date}T00:00:00Z`),
              adjClose: b.adjClose,
            });
          }
        }
        rows.sort((a, b) => a.tradeDate.getTime() - b.tradeDate.getTime());
        return rows;
      },
    },
  } as unknown as PrismaClient;
}

const AAA: FakeConstituent = {
  securityId: "s-aaa",
  ticker: "AAA",
  name: "Alpha Inc",
  sector: "Tech",
  subTheme: "Software",
};
const BBB: FakeConstituent = {
  securityId: "s-bbb",
  ticker: "BBB",
  name: "Beta Inc",
  sector: "Tech",
  subTheme: "Software",
};

/** POST quote that overlays AAA's last bar (2026-06-24) at +5% vs regular close. */
function ahQuote(): ExtendedTickerQuote {
  return {
    price: 109 * 1.05,
    session: "POST",
    asOfUnix: 0,
    tradeDateEt: "2026-06-24",
    regularClose: 109,
  };
}

describe("computeMarketMap — overlay D1 fallback", () => {
  it("uses the AH move for a stock with a print, and falls back to the regular close move (not blank) for one without", async () => {
    const db = fakeDb([AAA, BBB], {
      "s-aaa": risingSeries(),
      "s-bbb": risingSeries(),
    });
    // Overlay map contains AAA only → BBB has no after-hours print.
    const extendedQuotes = new Map<string, ExtendedTickerQuote>([
      ["AAA", ahQuote()],
    ]);

    const res = await computeMarketMap(
      db,
      "u1",
      "RETURN",
      "COMPANY",
      "SP500",
      {},
      { extendedQuotes },
    );

    const aaa = res.rows.find((r) => r.ticker === "AAA")!;
    const bbb = res.rows.find((r) => r.ticker === "BBB")!;

    // AAA: genuine after-hours move (+5%).
    expect(aaa.d1Source).toBe("AH");
    expect(aaa.cells.D1).toBeCloseTo(0.05, 12);

    // BBB: NO after-hours print → regular close-to-close move, never blank.
    expect(bbb.d1Source).toBe("REGULAR");
    expect(bbb.cells.D1).not.toBeNull();
    expect(bbb.cells.D1).toBeCloseTo(109 / 108 - 1, 12);

    // Diagnostics: exactly one fallback, no data gaps.
    expect(res.diagnostics.d1FallbackToRegular).toBe(1);
    expect(res.diagnostics.excludedInsufficientPrices).toBe(0);
    expect(res.diagnostics.allNullRows).toBe(0);
  });

  it("leaves d1Source undefined and D1 on the close-to-close chain when no overlay is requested", async () => {
    const db = fakeDb([AAA, BBB], {
      "s-aaa": risingSeries(),
      "s-bbb": risingSeries(),
    });

    const res = await computeMarketMap(db, "u1", "RETURN", "COMPANY", "SP500", {});

    for (const r of res.rows) {
      expect(r.d1Source).toBeUndefined();
      expect(r.cells.D1).toBeCloseTo(109 / 108 - 1, 12);
    }
    expect(res.diagnostics.d1FallbackToRegular).toBe(0);
  });

  it("excludes stocks with fewer than 5 bars and counts them in diagnostics", async () => {
    const ccc: FakeConstituent = {
      securityId: "s-ccc",
      ticker: "CCC",
      name: "Gamma Inc",
      sector: "Tech",
      subTheme: "Software",
    };
    const db = fakeDb([AAA, ccc], {
      "s-aaa": risingSeries(),
      "s-ccc": risingSeries().slice(0, 3), // only 3 bars
    });

    const res = await computeMarketMap(db, "u1", "RETURN", "COMPANY", "SP500", {});

    expect(res.rows.find((r) => r.ticker === "CCC")).toBeUndefined();
    expect(res.rows.find((r) => r.ticker === "AAA")).toBeDefined();
    expect(res.diagnostics.excludedInsufficientPrices).toBe(1);
  });
});
