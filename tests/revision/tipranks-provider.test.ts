import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/config/env", () => ({
  fmpApiKey: () => "test-key",
  fmpBaseUrl: () => "https://fmp.test",
  fmpCallsPerMinute: () => 3000,
}));

import { FmpEntitlementError } from "@/infrastructure/providers/fmp/fmp-client";
import {
  fetchTipRanksRatings,
  normalizeTipRanksAnalyst,
  normalizeTipRanksRating,
} from "@/infrastructure/providers/fmp/tipranks";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("normalizeTipRanksRating", () => {
  it("maps the verified tipranks-search row shape and lower-cases enums", () => {
    const out = normalizeTipRanksRating("aapl", {
      symbol: "AAPL",
      date: "2026-09-10T13:45:00.000Z",
      recommendationDate: "2026-09-10",
      expertUID: "uid-1",
      analystName: "Jane Doe",
      firmName: "Morgan Stanley",
      recommendation: "Buy",
      analystAction: "Maintained",
      priceTarget: 250,
      priceTargetCurrency: "USD",
    });
    expect(out).toMatchObject({
      ticker: "AAPL",
      ratingDate: "2026-09-10",
      publishedAt: "2026-09-10T13:45:00.000Z",
      expertUID: "uid-1",
      firmName: "Morgan Stanley",
      recommendation: "buy",
      analystAction: "maintained",
      priceTarget: 250,
    });
    expect(out!.raw.expertUID).toBe("uid-1"); // verbatim payload retained
  });
  it("falls back to the timestamp date and upper-cases the caller symbol when symbol is absent", () => {
    const out = normalizeTipRanksRating("mu", { date: "2026-09-10T13:45:00.000Z", priceTarget: null });
    expect(out).toMatchObject({ ticker: "MU", ratingDate: "2026-09-10", priceTarget: null });
  });
  it("returns null when no date is usable", () => {
    expect(normalizeTipRanksRating("MU", { expertUID: "x" })).toBeNull();
  });
});

describe("normalizeTipRanksAnalyst", () => {
  it("requires expertUID", () => {
    expect(normalizeTipRanksAnalyst({ analystName: "x" })).toBeNull();
    expect(normalizeTipRanksAnalyst({ expertUID: "u", successRate: 0.6 })).toMatchObject({ expertUID: "u", successRate: 0.6 });
  });
});

describe("fetchTipRanksRatings HTTP contract", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pins date filtering to from/to (fromDate/toDate are silently ignored by the API)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await fetchTipRanksRatings("AAPL", { from: "2026-01-01", to: "2026-02-01", limit: 500, page: 2 });
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/stable/tipranks-search");
    expect(url.searchParams.get("symbol")).toBe("AAPL");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-02-01");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("fromDate")).toBe(false);
    expect(url.searchParams.has("toDate")).toBe(false);
  });
  it("defaults to the full-history limit", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await fetchTipRanksRatings("AAPL");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("limit")).toBe("10000");
  });
  it("surfaces HTTP 402 as FmpEntitlementError without retrying", async () => {
    fetchMock.mockResolvedValue(new Response("Payment Required", { status: 402 }));
    await expect(fetchTipRanksRatings("AAPL")).rejects.toBeInstanceOf(FmpEntitlementError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("drops rows without a date and normalizes the rest", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { symbol: "AAPL", recommendationDate: "2026-09-10", expertUID: "a", priceTarget: 200 },
        { symbol: "AAPL", expertUID: "b" },
      ]),
    );
    const out = await fetchTipRanksRatings("AAPL");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ expertUID: "a", priceTarget: 200 });
  });
});
