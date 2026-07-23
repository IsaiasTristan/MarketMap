/**
 * Tests for the FMP bulk-EOD tail path — the institutional fix for the
 * "Live overlay skipped (DB stale)" warning flood. Covers the pure bulk-CSV
 * parser, the missing-date computation, the ticker→FMP-symbol normalisation,
 * and the shared upsert helper's split self-heal escalation.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, it, expect } from "vitest";
import { parseEodBulkRows } from "../../src/infrastructure/providers/fmp/prices";
import {
  tradingDatesBetween,
  fmpBulkSymbol,
} from "../../src/server/services/ingest-universe.service";
import { upsertTailBars } from "../../src/server/services/price-ingest.service";

describe("parseEodBulkRows", () => {
  it("keys by upper-cased symbol and prefers adjClose over close", () => {
    const out = parseEodBulkRows([
      { symbol: "aapl", date: "2026-07-22", close: "325.89", adjClose: "324.10" },
    ]);
    expect(out.get("AAPL")).toEqual({ close: 325.89, adjClose: 324.1 });
  });

  it("falls back to close when adjClose is absent", () => {
    const out = parseEodBulkRows([
      { symbol: "MSFT", date: "2026-07-22", close: "390.34" },
    ]);
    expect(out.get("MSFT")).toEqual({ close: 390.34, adjClose: 390.34 });
  });

  it("restricts to the wanted symbol set", () => {
    const rows = [
      { symbol: "AAPL", close: "1", adjClose: "1" },
      { symbol: "HRKEUR", close: "0.13", adjClose: "0.13" },
    ];
    const out = parseEodBulkRows(rows, new Set(["AAPL"]));
    expect([...out.keys()]).toEqual(["AAPL"]);
  });

  it("drops rows with a non-positive or unparseable adjusted close", () => {
    const out = parseEodBulkRows([
      { symbol: "A", close: "0", adjClose: "0" },
      { symbol: "B", close: "x", adjClose: "" },
    ]);
    expect(out.size).toBe(0);
  });
});

describe("tradingDatesBetween", () => {
  it("returns weekdays strictly after 'from' through 'to', skipping the weekend", () => {
    // Fri 2026-07-17 (exclusive) → Wed 2026-07-22: Mon 20, Tue 21, Wed 22.
    expect(tradingDatesBetween("2026-07-17", "2026-07-22", 10)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ]);
  });

  it("is empty when the tape is already current (from === to)", () => {
    expect(tradingDatesBetween("2026-07-22", "2026-07-22", 10)).toEqual([]);
  });

  it("caps to the most recent N dates", () => {
    const out = tradingDatesBetween("2026-06-30", "2026-07-22", 2);
    expect(out).toEqual(["2026-07-21", "2026-07-22"]);
  });
});

describe("fmpBulkSymbol", () => {
  it("rewrites a single trailing class-share suffix to a dash", () => {
    expect(fmpBulkSymbol("BRK.B")).toBe("BRK-B");
    expect(fmpBulkSymbol("bf.a")).toBe("BF-A");
  });

  it("leaves ordinary and foreign-suffixed symbols intact (upper-cased)", () => {
    expect(fmpBulkSymbol("aapl")).toBe("AAPL");
    expect(fmpBulkSymbol("NOVO-B.CO")).toBe("NOVO-B.CO");
  });
});

/** Minimal Prisma stub capturing PriceHistory upserts + miss-clears. */
function makeDb(stored: { date: string; adjClose: number }[]) {
  const upserts: string[] = [];
  const cleared: string[] = [];
  const db = {
    priceHistory: {
      findMany: async () =>
        stored.map((s) => ({
          tradeDate: new Date(`${s.date}T12:00:00.000Z`),
          adjClose: s.adjClose,
        })),
      upsert: async (arg: { create: { tradeDate: Date } }) => {
        upserts.push(arg.create.tradeDate.toISOString().slice(0, 10));
      },
    },
    security: {
      update: async (arg: { where: { id: string } }) => {
        cleared.push(arg.where.id);
      },
    },
  } as unknown as PrismaClient;
  return { db, upserts, cleared };
}

describe("upsertTailBars (split self-heal)", () => {
  it("escalates (rescaled=true) and upserts nothing when a bar disagrees > tolerance", async () => {
    const { db, upserts } = makeDb([{ date: "2026-07-20", adjClose: 100 }]);
    const res = await upsertTailBars(db, "sec1", [
      { date: "2026-07-20", adjClose: 10 }, // 10:1 reverse split → ratio 0.1
    ]);
    expect(res.rescaled).toBe(true);
    expect(res.upserted).toBe(0);
    expect(upserts).toEqual([]);
  });

  it("upserts every bar and clears misses when within the noise band", async () => {
    const { db, upserts, cleared } = makeDb([{ date: "2026-07-20", adjClose: 100 }]);
    const res = await upsertTailBars(db, "sec1", [
      { date: "2026-07-20", adjClose: 100.5 },
      { date: "2026-07-21", adjClose: 101.2 },
    ]);
    expect(res.rescaled).toBe(false);
    expect(res.upserted).toBe(2);
    expect(upserts).toEqual(["2026-07-20", "2026-07-21"]);
    expect(cleared).toEqual(["sec1"]);
  });

  it("no-ops on an empty bar list", async () => {
    const { db, upserts, cleared } = makeDb([]);
    const res = await upsertTailBars(db, "sec1", []);
    expect(res).toEqual({ upserted: 0, rescaled: false });
    expect(upserts).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
