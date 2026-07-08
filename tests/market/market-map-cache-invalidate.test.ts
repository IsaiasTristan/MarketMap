/**
 * Tests for the market-map cache self-heal on price ingest.
 *
 * `ingestChangedMarketMap` is the pure gate the ingest route uses to decide
 * whether a completed run touched data; `invalidateMarketMapCache` is the
 * (side-effecting) stale-mark scoped to the affected universe. Rows are
 * MARKED stale rather than deleted so the GET route can keep serving the
 * last-known grid instantly while a background recompute refreshes it
 * (stale-while-revalidate) — deleting would force the next viewer to block
 * on a 5–28s cold compute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.hoisted` so the spies exist before the hoisted `vi.mock` factory runs.
const { deleteMany, updateMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(async () => ({ count: 0 })),
  updateMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/infrastructure/db/client", () => ({
  prisma: {
    marketMapSnapshot: { deleteMany, updateMany },
  },
}));

import {
  invalidateMarketMapCache,
  ingestChangedMarketMap,
} from "../../src/server/services/market-map-cache.service";

beforeEach(() => {
  deleteMany.mockClear();
  updateMany.mockClear();
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
  it("marks every cached blob for the universe stale (never deletes)", async () => {
    await invalidateMarketMapCache("univ-123");
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { universeId: "univ-123" },
      data: { stale: true },
    });
    // Deleting would force the next read to block on a cold compute — the
    // stale blob must survive to be served while revalidation runs.
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
