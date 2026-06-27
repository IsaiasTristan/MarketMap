/**
 * Tests for the bulk spark quote provider — pure parse of the spark body and
 * the chunked fetch path (chunking, 401 retry/backoff, servedVia, failed
 * accumulation) with a mocked global fetch.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  parseSparkBody,
  fetchYahooBulkQuotes,
} from "../../src/infrastructure/providers/yahoo-bulk-quote";

describe("parseSparkBody", () => {
  it("parses the flat shape into {price, prevClose, asOfUnix}", () => {
    const body = {
      AAPL: {
        symbol: "AAPL",
        close: [283.78],
        chartPreviousClose: 275.15,
        previousClose: null,
        timestamp: [1782480600],
      },
      MSFT: {
        symbol: "MSFT",
        close: [372.97],
        chartPreviousClose: 352.83,
        timestamp: [1782480600],
      },
    };
    const out = parseSparkBody(body);
    expect(out.get("AAPL")).toEqual({
      price: 283.78,
      prevClose: 275.15,
      asOfUnix: 1782480600,
    });
    expect(out.get("MSFT")?.prevClose).toBe(352.83);
  });

  it("prefers previousClose over chartPreviousClose when present", () => {
    const out = parseSparkBody({
      X: { close: [10], previousClose: 9, chartPreviousClose: 8, timestamp: [1] },
    });
    expect(out.get("X")?.prevClose).toBe(9);
  });

  it("uses the last finite close and its timestamp, skipping trailing nulls", () => {
    const out = parseSparkBody({
      X: { close: [10, 11, null], chartPreviousClose: 9, timestamp: [1, 2, 3] },
    });
    expect(out.get("X")).toEqual({ price: 11, prevClose: 9, asOfUnix: 2 });
  });

  it("drops a symbol with no usable prior close", () => {
    const out = parseSparkBody({
      X: { close: [10], previousClose: null, chartPreviousClose: null, timestamp: [1] },
    });
    expect(out.has("X")).toBe(false);
  });

  it("parses the legacy wrapped shape", () => {
    const body = {
      spark: {
        result: [
          {
            symbol: "AAPL",
            response: [
              {
                meta: { chartPreviousClose: 275.15 },
                timestamp: [1782480600],
                indicators: { quote: [{ close: [283.78] }] },
              },
            ],
          },
        ],
      },
    };
    const out = parseSparkBody(body);
    expect(out.get("AAPL")).toEqual({
      price: 283.78,
      prevClose: 275.15,
      asOfUnix: 1782480600,
    });
  });

  it("returns an empty map for non-object input", () => {
    expect(parseSparkBody(null).size).toBe(0);
    expect(parseSparkBody("nope").size).toBe(0);
  });
});

function sparkResponse(symbols: Record<string, { price: number; prev: number }>) {
  const body: Record<string, unknown> = {};
  for (const [sym, { price, prev }] of Object.entries(symbols)) {
    body[sym] = { close: [price], chartPreviousClose: prev, timestamp: [1] };
  }
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("fetchYahooBulkQuotes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chunks symbols into multiple requests and keys by input ticker", async () => {
    const tickers = Array.from({ length: 120 }, (_, i) => `T${i}`);
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      const syms = (u.searchParams.get("symbols") ?? "").split(",");
      const body: Record<string, { price: number; prev: number }> = {};
      for (const s of syms) body[s] = { price: 10, prev: 9 };
      return sparkResponse(body);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchYahooBulkQuotes(tickers);
    // 120 symbols / 50 per chunk = 3 requests.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.quotes.size).toBe(120);
    expect(res.quotes.get("T0")).toEqual({ price: 10, prevClose: 9, asOfUnix: 1 });
    expect(res.servedVia).toBe("spark");
    expect(res.failed).toEqual([]);
  });

  it("retries a 401 then succeeds (backoff path)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      calls++;
      if (calls === 1) return new Response("nope", { status: 401 });
      const u = new URL(String(url));
      const syms = (u.searchParams.get("symbols") ?? "").split(",");
      const body: Record<string, { price: number; prev: number }> = {};
      for (const s of syms) body[s] = { price: 5, prev: 4 };
      return sparkResponse(body);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchYahooBulkQuotes(["AAPL"]);
    expect(calls).toBe(2);
    expect(res.quotes.get("AAPL")).toEqual({ price: 5, prevClose: 4, asOfUnix: 1 });
  });

  it("accumulates tickers a failed chunk omitted into failed[]", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchYahooBulkQuotes(["AAPL", "MSFT"]);
    expect(res.quotes.size).toBe(0);
    expect(res.failed.sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("marks a symbol missing from the response body as failed", async () => {
    const fetchMock = vi.fn(async () =>
      sparkResponse({ AAPL: { price: 10, prev: 9 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchYahooBulkQuotes(["AAPL", "MSFT"]);
    expect(res.quotes.has("AAPL")).toBe(true);
    expect(res.failed).toEqual(["MSFT"]);
  });
});
