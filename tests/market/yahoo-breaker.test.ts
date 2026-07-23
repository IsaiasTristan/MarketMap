/**
 * Tests for the shared Yahoo circuit breaker + fetch wrapper (yahoo-fetch.ts)
 * and the live-snapshot file store (live-snapshot-store.ts) that back the
 * event-loop offload.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  yahooFetchRetry,
  yahooBreakerOpen,
  recordYahooFailure,
  recordYahooSuccess,
  _resetYahooBreaker,
} from "../../src/infrastructure/providers/yahoo-fetch";
import {
  writeSnapshotFile,
  readSnapshotFile,
  snapshotFileMtimeMs,
} from "../../src/server/services/live-snapshot-store";

describe("yahoo circuit breaker", () => {
  beforeEach(() => {
    _resetYahooBreaker();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetYahooBreaker();
  });

  it("returns the response and keeps the breaker closed on success", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await yahooFetchRetry("https://x/y", { maxAttempts: 1 });
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(yahooBreakerOpen()).toBe(false);
  });

  it("returns null and records a failure on a 5xx (no throw)", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await yahooFetchRetry("https://x/y", { maxAttempts: 1 });
    expect(res).toBeNull();
  });

  it("opens after a burst of failures, then short-circuits without fetching", async () => {
    // Drive well past the failure threshold within the window.
    for (let i = 0; i < 20; i++) recordYahooFailure();
    expect(yahooBreakerOpen()).toBe(true);

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await yahooFetchRetry("https://x/y", { maxAttempts: 3 });
    expect(res).toBeNull();
    // Breaker OPEN → the network is skipped entirely.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a success closes an open breaker", () => {
    for (let i = 0; i < 20; i++) recordYahooFailure();
    expect(yahooBreakerOpen()).toBe(true);
    recordYahooSuccess();
    expect(yahooBreakerOpen()).toBe(false);
  });
});

describe("live-snapshot store round-trip", () => {
  const NAME = "__test-extended-hours";
  afterEach(() => {
    try {
      rmSync(join(process.cwd(), ".live-snapshots", `${NAME}.json`));
    } catch {
      /* ignore */
    }
  });

  it("writes and reads back a Map-serialized snapshot; exposes an mtime", () => {
    const payload = {
      session: "POST",
      asOf: "2026-07-23T01:00:00.000Z",
      quotes: [["AAPL", { price: 283.78, session: "POST", asOfUnix: 1, tradeDateEt: "2026-07-22", regularClose: 275.15 }]],
    };
    writeSnapshotFile(NAME, payload);

    const back = readSnapshotFile<typeof payload>(NAME);
    expect(back).toEqual(payload);
    // The serialized quotes rehydrate into a Map on the read side.
    expect(new Map(back!.quotes).get("AAPL")?.price).toBe(283.78);
    expect(typeof snapshotFileMtimeMs(NAME)).toBe("number");
  });

  it("returns null for an absent snapshot", () => {
    expect(readSnapshotFile("__does-not-exist")).toBeNull();
    expect(snapshotFileMtimeMs("__does-not-exist")).toBeNull();
  });
});
