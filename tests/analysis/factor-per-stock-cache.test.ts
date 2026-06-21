/**
 * Tests for the per-stock factor grid cache service. The Prisma client and the
 * heavy regression service are mocked so these stay pure/fast: we exercise the
 * read/write round-trip and the (model, window) combo enumeration of the daily
 * precompute job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PerStockResult } from "../../src/server/services/factor-per-stock.service";

// In-memory stand-in for the PerStockGridSnapshot table.
const store = new Map<string, Record<string, unknown>>();

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    perStockGridSnapshot: {
      findUnique: vi.fn(async ({ where }: { where: { model_regressionWindow: { model: string; regressionWindow: number } } }) => {
        const { model, regressionWindow } = where.model_regressionWindow;
        return store.get(`${model}|${regressionWindow}`) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { model_regressionWindow: { model: string; regressionWindow: number } };
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          const { model, regressionWindow } = where.model_regressionWindow;
          const key = `${model}|${regressionWindow}`;
          const existing = store.get(key);
          const row = existing ? { ...existing, ...update } : { ...create };
          store.set(key, row);
          return row;
        },
      ),
    },
  },
}));

const runMock = vi.fn();
vi.mock("@/server/services/factor-per-stock.service", () => ({
  runPerStockFactors: (args: unknown) => runMock(args),
}));

import {
  readPerStockGridCache,
  writePerStockGridCache,
  precomputeAllPerStockGrids,
  GRID_CACHE_MODELS,
  GRID_CACHE_WINDOWS,
} from "../../src/server/services/factor-per-stock-cache.service";

function fakeResult(overrides: Partial<PerStockResult> = {}): PerStockResult {
  return {
    asOfDate: "2026-06-12",
    rows: [{ ticker: "AAPL" } as unknown as PerStockResult["rows"][number]],
    usableFactors: ["EQ", "MOM"],
    ...overrides,
  } as PerStockResult;
}

beforeEach(() => {
  store.clear();
  runMock.mockReset();
});

describe("per-stock grid cache round-trip", () => {
  it("returns null on a miss", async () => {
    expect(await readPerStockGridCache("MACRO14", 252)).toBeNull();
  });

  it("write then read returns the same result payload", async () => {
    const result = fakeResult();
    await writePerStockGridCache("MACRO14", 252, result);
    const got = await readPerStockGridCache("MACRO14", 252);
    expect(got).not.toBeNull();
    expect(got!.asOfDate).toBe("2026-06-12");
    expect(got!.usableFactors).toEqual(["EQ", "MOM"]);
  });

  it("upsert overwrites the prior row for the same (model, window)", async () => {
    await writePerStockGridCache("MACRO14", 252, fakeResult({ asOfDate: "2026-06-10" }));
    await writePerStockGridCache("MACRO14", 252, fakeResult({ asOfDate: "2026-06-12" }));
    const got = await readPerStockGridCache("MACRO14", 252);
    expect(got!.asOfDate).toBe("2026-06-12");
  });

  it("keeps distinct (model, window) keys separate", async () => {
    await writePerStockGridCache("MACRO14", 252, fakeResult({ asOfDate: "2026-06-12" }));
    await writePerStockGridCache("MACRO14", 378, fakeResult({ asOfDate: "2026-06-11" }));
    expect((await readPerStockGridCache("MACRO14", 252))!.asOfDate).toBe("2026-06-12");
    expect((await readPerStockGridCache("MACRO14", 378))!.asOfDate).toBe("2026-06-11");
  });
});

describe("precompute combo enumeration", () => {
  it("only precomputes MACRO14 (academic presets dropped from the cache)", () => {
    expect(GRID_CACHE_MODELS).toEqual(["MACRO14"]);
  });

  it("windows match the UI HORIZON presets exactly", () => {
    expect(GRID_CACHE_WINDOWS).toEqual([63, 252, 504, 756]);
  });

  it("precomputes every (model, window) combo and caches each", async () => {
    runMock.mockImplementation(() => fakeResult());
    const { entries } = await precomputeAllPerStockGrids();

    const expectedCount = GRID_CACHE_MODELS.length * GRID_CACHE_WINDOWS.length;
    expect(entries).toHaveLength(expectedCount);
    expect(runMock).toHaveBeenCalledTimes(expectedCount);
    expect(entries.every((e) => e.status === "ok")).toBe(true);

    for (const window of GRID_CACHE_WINDOWS) {
      expect(await readPerStockGridCache("MACRO14", window)).not.toBeNull();
    }
  });

  it("records an error entry without aborting the rest of the run", async () => {
    runMock.mockImplementation((args: { window: number }) => {
      if (args.window === 63) throw new Error("boom");
      return fakeResult();
    });
    const { entries } = await precomputeAllPerStockGrids();

    const errored = entries.filter((e) => e.status === "error");
    expect(errored).toHaveLength(1);
    expect(errored[0]!.window).toBe(63);
    expect(errored[0]!.error).toContain("boom");
    // The failing combo is not cached, but the others still are.
    expect(await readPerStockGridCache("MACRO14", 63)).toBeNull();
    expect(await readPerStockGridCache("MACRO14", 252)).not.toBeNull();
  });

  it("marks an empty (null) result without writing the cache", async () => {
    runMock.mockImplementation((args: { window: number }) =>
      args.window === 756 ? null : fakeResult(),
    );
    const { entries } = await precomputeAllPerStockGrids();
    const empty = entries.find((e) => e.window === 756)!;
    expect(empty.status).toBe("empty");
    expect(await readPerStockGridCache("MACRO14", 756)).toBeNull();
  });
});
