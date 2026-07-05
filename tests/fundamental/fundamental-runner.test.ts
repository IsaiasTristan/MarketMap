import { describe, expect, it } from "vitest";
import { selectReportedTickers } from "@/server/services/fundamental-runner";
import { isWeeklyStale } from "@/server/services/revision-runner";

const DAY = 24 * 60 * 60_000;

describe("fundamental runner gates", () => {
  it("weekly sweep reuses the revision staleness gate (>= 7 days or missing)", () => {
    const now = Date.UTC(2026, 6, 5);
    expect(isWeeklyStale(null, now)).toBe(true);
    expect(isWeeklyStale(now - 2 * DAY, now)).toBe(false);
    expect(isWeeklyStale(now - 7 * DAY, now)).toBe(true);
  });
});

describe("selectReportedTickers", () => {
  const universe = ["AAPL", "MSFT", "nvda"];

  it("keeps only universe tickers with an entry on/after sinceIso", () => {
    const entries = [
      { ticker: "AAPL", date: "2026-07-03" }, // in universe, in range
      { ticker: "MSFT", date: "2026-07-01" }, // in universe, before range
      { ticker: "TSLA", date: "2026-07-04" }, // out of universe
    ];
    expect(selectReportedTickers(entries, universe, "2026-07-02")).toEqual(["AAPL"]);
  });

  it("is case-insensitive on both sides and dedupes multiple entries", () => {
    const entries = [
      { ticker: "nvda", date: "2026-07-03" },
      { ticker: "NVDA", date: "2026-07-04" }, // duplicate reporter (e.g. revised time)
    ];
    expect(selectReportedTickers(entries, universe, "2026-07-02")).toEqual(["NVDA"]);
  });

  it("sinceIso is inclusive (yesterday's AMC reporters get re-covered)", () => {
    const entries = [{ ticker: "AAPL", date: "2026-07-02" }];
    expect(selectReportedTickers(entries, universe, "2026-07-02")).toEqual(["AAPL"]);
  });

  it("returns empty for an empty calendar or empty universe", () => {
    expect(selectReportedTickers([], universe, "2026-07-02")).toEqual([]);
    expect(
      selectReportedTickers([{ ticker: "AAPL", date: "2026-07-03" }], [], "2026-07-02"),
    ).toEqual([]);
  });
});
