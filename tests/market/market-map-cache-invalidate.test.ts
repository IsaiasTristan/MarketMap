/**
 * Tests for the market-map cache self-heal on price ingest.
 *
 * `ingestChangedMarketMap` is the pure gate the ingest route uses to decide
 * whether a completed run touched data; `invalidateMarketMapCache` is the
 * (side-effecting) drop scoped to the affected universe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { deleteMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    marketMapSnapshot: { deleteMany },
  },
}));

import {
  invalidateMarketMapCache,
  ingestChangedMarketMap,
} from "../../src/server/services/market-map-cache.service";

beforeEach(() => {
  deleteMany.mockClear();
});

describe("ingestChangedMarketMap", () => {
  it("is true when new bars were written", () => {
    expect(ingestChangedMarketMap({ bars: 12, autoDeactivated: [] })).toBe(true);
  });

  it("is true when a ticker was auto-deactivated even with no new bars", () => {
    expect(
      ingestChangedMarketMap({ bars: 0, autoDeactivated: ["DEAD"] }),
    ).toBe(true);
  });

  it("is false when nothing changed (no bars, no deactivations)", () => {
    expect(ingestChangedMarketMap({ bars: 0, autoDeactivated: [] })).toBe(false);
  });
});

describe("invalidateMarketMapCache", () => {
  it("drops every cached blob scoped to the given universe", async () => {
    await invalidateMarketMapCache("univ-123");
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { universeId: "univ-123" } });
  });
});
