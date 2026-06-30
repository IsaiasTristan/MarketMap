/**
 * Tests for the company-name resolver + universe name backfill.
 *
 * Covers the `name === ticker` "missing" predicate (what makes user edits
 * final), the FMP-first / Yahoo-fallback resolution order, and that the
 * backfill only touches rows whose name still equals the ticker (write-once).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchProfile, fmpPool, fetchYahooDisplayName, invalidate } = vi.hoisted(
  () => ({
    fetchProfile: vi.fn(),
    fetchYahooDisplayName: vi.fn(),
    invalidate: vi.fn(async () => {}),
    fmpPool: vi.fn(
      async (
        items: unknown[],
        worker: (item: unknown, i: number) => Promise<unknown>,
      ) => {
        const results: Array<{ item: unknown; value: unknown }> = [];
        const failures: Array<{ item: unknown; error: string }> = [];
        for (let i = 0; i < items.length; i++) {
          try {
            results.push({ item: items[i], value: await worker(items[i], i) });
          } catch (e) {
            failures.push({ item: items[i], error: String(e) });
          }
        }
        return { results, failures };
      },
    ),
  }),
);

vi.mock("@/infrastructure/providers/fmp", () => ({ fetchProfile, fmpPool }));
vi.mock("@/infrastructure/providers/yahoo-quote-http", () => ({
  fetchYahooDisplayName,
}));
vi.mock("@/server/services/market-map-cache.service", () => ({
  invalidateMarketMapCache: invalidate,
}));

import {
  nameIsMissing,
  resolveCompanyName,
  backfillUniverseConstituentNames,
  pickDisplayName,
} from "../../src/server/services/security-name.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nameIsMissing", () => {
  it("is true when the name equals the ticker (case / space-insensitive)", () => {
    expect(nameIsMissing("AAPL", "AAPL")).toBe(true);
    expect(nameIsMissing(" aapl ", "AAPL")).toBe(true);
  });
  it("is false once a real name differs from the ticker", () => {
    expect(nameIsMissing("Apple Inc.", "AAPL")).toBe(false);
  });
});

describe("resolveCompanyName", () => {
  it("prefers FMP and does not call Yahoo when FMP yields a real name", async () => {
    fetchProfile.mockResolvedValueOnce({ companyName: "Apple Inc." });
    const name = await resolveCompanyName("AAPL");
    expect(name).toBe("Apple Inc.");
    expect(fetchYahooDisplayName).not.toHaveBeenCalled();
  });

  it("falls back to Yahoo when FMP returns nothing usable", async () => {
    fetchProfile.mockResolvedValueOnce(null);
    fetchYahooDisplayName.mockResolvedValueOnce("Microsoft Corp.");
    const name = await resolveCompanyName("MSFT");
    expect(name).toBe("Microsoft Corp.");
  });

  it("falls back to Yahoo when FMP echoes the ticker as the name", async () => {
    fetchProfile.mockResolvedValueOnce({ companyName: "NVDA" });
    fetchYahooDisplayName.mockResolvedValueOnce("NVIDIA Corp.");
    const name = await resolveCompanyName("NVDA");
    expect(name).toBe("NVIDIA Corp.");
  });

  it("returns null when neither provider yields a real name", async () => {
    fetchProfile.mockResolvedValueOnce(null);
    fetchYahooDisplayName.mockResolvedValueOnce("ZZZZ");
    expect(await resolveCompanyName("ZZZZ")).toBeNull();
  });
});

describe("pickDisplayName", () => {
  const names = new Map([
    ["AAPL", "Apple Inc."],
    ["MSFT", "Microsoft Corp."],
    ["ZZZZ", "ZZZZ"], // market-map name still equals the ticker (not yet filled)
  ]);

  it("uses the market-map source (Security.name) when the ticker is present", () => {
    expect(pickDisplayName(names, "aapl", "STALE BAKED")).toBe("Apple Inc.");
  });

  it("returns the source even when it still equals the ticker (parity with the market map)", () => {
    expect(pickDisplayName(names, "ZZZZ", "Some Baked Name")).toBe("ZZZZ");
  });

  it("falls back to the baked name when the ticker is outside the universe", () => {
    expect(pickDisplayName(names, "TSLA", "Tesla, Inc.")).toBe("Tesla, Inc.");
  });

  it("falls back to the upper-cased ticker when there is no source and no baked name", () => {
    expect(pickDisplayName(names, "tsla", null)).toBe("TSLA");
    expect(pickDisplayName(names, "tsla", "")).toBe("TSLA");
  });
});

describe("backfillUniverseConstituentNames", () => {
  function makeDb(
    constituents: { security: { id: string; ticker: string; name: string } }[],
  ) {
    const updated: { id: string; name: string }[] = [];
    const db = {
      universeConstituent: {
        findMany: vi.fn(async () => constituents),
      },
      security: {
        update: vi.fn(async (args: { where: { id: string }; data: { name: string } }) => {
          updated.push({ id: args.where.id, name: args.data.name });
        }),
      },
    };
    return { db, updated };
  }

  it("only fills rows whose name equals the ticker and leaves named rows alone", async () => {
    fetchProfile.mockImplementation(async (sym: string) =>
      sym === "AAPL" ? { companyName: "Apple Inc." } : null,
    );
    const { db, updated } = makeDb([
      { security: { id: "1", ticker: "AAPL", name: "AAPL" } },
      { security: { id: "2", ticker: "MSFT", name: "Microsoft Corp." } },
    ]);

    const result = await backfillUniverseConstituentNames(db as never, "u1");

    expect(result.scanned).toBe(1);
    expect(result.filled).toBe(1);
    expect(result.remaining).toBe(0);
    expect(updated).toEqual([{ id: "1", name: "Apple Inc." }]);
    expect(invalidate).toHaveBeenCalledWith("u1");
  });

  it("reports unresolved rows as remaining and skips the cache drop", async () => {
    fetchProfile.mockResolvedValue(null);
    fetchYahooDisplayName.mockImplementation(async (sym: string) => sym);
    const { db, updated } = makeDb([
      { security: { id: "9", ticker: "ZZZZ", name: "ZZZZ" } },
    ]);

    const result = await backfillUniverseConstituentNames(db as never, "u1");

    expect(result.scanned).toBe(1);
    expect(result.filled).toBe(0);
    expect(result.remaining).toBe(1);
    expect(updated).toHaveLength(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does nothing when no constituent needs a name", async () => {
    const { db } = makeDb([
      { security: { id: "2", ticker: "MSFT", name: "Microsoft Corp." } },
    ]);

    const result = await backfillUniverseConstituentNames(db as never, "u1");

    expect(result).toEqual({ scanned: 0, filled: 0, remaining: 0, failures: [] });
    expect(fmpPool).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
