import { describe, expect, it } from "vitest";
import {
  baseRateLabel,
  forwardExcessReturn,
  priceAsOf,
  stageEntryEpisodes,
  summarizeCohort,
  BASE_RATE_MIN_N,
} from "@/domain/calculations/base-rates";

describe("base-rates: forward excess return", () => {
  it("subtracts the benchmark's return from the stock's", () => {
    // stock +20%, benchmark +5% ⇒ excess +15%.
    expect(forwardExcessReturn(100, 120, 100, 105)).toBeCloseTo(0.15, 6);
  });
  it("can be negative (underperformed the benchmark)", () => {
    expect(forwardExcessReturn(100, 102, 100, 110)).toBeCloseTo(-0.08, 6);
  });
  it("returns null for a non-positive price", () => {
    expect(forwardExcessReturn(0, 120, 100, 105)).toBeNull();
    expect(forwardExcessReturn(100, 120, 100, 0)).toBeNull();
  });
});

describe("base-rates: cohort summary (N gating)", () => {
  it("reports insufficient (null stats) when N < 30, never a number without its N", () => {
    const s = summarizeCohort(Array(10).fill(0.05));
    expect(s.sufficient).toBe(false);
    expect(s.excessReturn).toBeNull();
    expect(s.hitRate).toBeNull();
    expect(s.n).toBe(10);
    expect(baseRateLabel("durable builds", s, "2Q")).toMatch(/insufficient history \(n=10\)/);
  });

  it("computes mean excess + hit rate once N ≥ 30", () => {
    const excess = [...Array(20).fill(0.1), ...Array(20).fill(-0.02)]; // 40 obs
    const s = summarizeCohort(excess);
    expect(s.n).toBe(40);
    expect(s.sufficient).toBe(true);
    expect(s.excessReturn).toBeCloseTo(0.04, 6);
    expect(s.hitRate).toBeCloseTo(0.5, 6);
    expect(baseRateLabel("durable builds", s, "2Q")).toMatch(/\+4\.0% excess next 2Q \(n=40, 50% hit\)/);
  });

  it("uses BASE_RATE_MIN_N = 30 as the threshold", () => {
    expect(BASE_RATE_MIN_N).toBe(30);
    expect(summarizeCohort(Array(29).fill(0.01)).sufficient).toBe(false);
    expect(summarizeCohort(Array(30).fill(0.01)).sufficient).toBe(true);
  });
});

describe("base-rates: event-based cohort episodes (Part 4)", () => {
  it("a name FORMING for 3 consecutive quarters is ONE episode, not three", () => {
    const eps = stageEntryEpisodes([null, "FORMING", "FORMING", "FORMING", null]);
    expect(eps).toEqual([{ index: 1, stage: "FORMING" }]);
  });
  it("re-entry into the same stage after leaving is a NEW episode", () => {
    const eps = stageEntryEpisodes(["FORMING", null, "FORMING"]);
    expect(eps).toEqual([
      { index: 0, stage: "FORMING" },
      { index: 2, stage: "FORMING" },
    ]);
  });
  it("each distinct stage transition is its own entry (DURABLE then BROKEN)", () => {
    const eps = stageEntryEpisodes(["DURABLE", "DURABLE", "BROKEN"]);
    expect(eps).toEqual([
      { index: 0, stage: "DURABLE" },
      { index: 2, stage: "BROKEN" },
    ]);
  });
  it("ignores null gaps entirely", () => {
    expect(stageEntryEpisodes([null, null, null])).toEqual([]);
  });
});

describe("base-rates: priceAsOf (no lookahead)", () => {
  const series = [
    { t: 10, px: 100 },
    { t: 20, px: 110 },
    { t: 30, px: 120 },
  ];
  it("picks the first close on/after the entry date — never earlier", () => {
    expect(priceAsOf(series, 15)).toBe(110); // first t≥15 is t=20
    expect(priceAsOf(series, 20)).toBe(110); // inclusive
    expect(priceAsOf(series, 5)).toBe(100);
  });
  it("returns null when the entry date is past the last close (no backfill)", () => {
    expect(priceAsOf(series, 31)).toBeNull();
  });
  it("entry is chosen strictly after the filing date, so period-end prices are never used", () => {
    // A filing lands after period-end; the entry close is the first at/after it,
    // proving we never read the (earlier) period-end price.
    const periodEnd = 20;
    const filing = 30; // ~46 days later, mapped into this toy timeline
    expect(priceAsOf(series, filing)).toBe(120);
    expect(priceAsOf(series, filing)).not.toBe(priceAsOf(series, periodEnd));
  });
});
