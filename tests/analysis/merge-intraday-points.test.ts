import { describe, expect, it } from "vitest";
import {
  appendSparklineTail,
  mergeIntradayPoints,
} from "@/lib/holdings/merge-intraday-points";

describe("mergeIntradayPoints", () => {
  it("returns existing unchanged when incoming is empty", () => {
    const existing = [{ t: "2026-06-23T14:00:00Z", price: 100 }];
    expect(mergeIntradayPoints(existing, [])).toEqual(existing);
  });

  it("returns incoming when existing is empty", () => {
    const incoming = [
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
    ];
    expect(mergeIntradayPoints([], incoming)).toEqual(incoming);
  });

  it("appends points with newer timestamps", () => {
    const existing = [
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
    ];
    const incoming = [
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
      { t: "2026-06-23T14:02:00Z", price: 102 },
      { t: "2026-06-23T14:03:00Z", price: 103 },
    ];
    expect(mergeIntradayPoints(existing, incoming)).toEqual([
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
      { t: "2026-06-23T14:02:00Z", price: 102 },
      { t: "2026-06-23T14:03:00Z", price: 103 },
    ]);
  });

  it("updates price in place when timestamp matches", () => {
    const existing = [
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
    ];
    const incoming = [{ t: "2026-06-23T14:01:00Z", price: 101.5 }];
    expect(mergeIntradayPoints(existing, incoming)).toEqual([
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101.5 },
    ]);
  });

  it("does not duplicate when refetch returns overlapping tail", () => {
    const existing = [
      { t: "2026-06-23T14:00:00Z", price: 100 },
      { t: "2026-06-23T14:01:00Z", price: 101 },
      { t: "2026-06-23T14:02:00Z", price: 102 },
    ];
    const incoming = [
      { t: "2026-06-23T14:01:00Z", price: 101 },
      { t: "2026-06-23T14:02:00Z", price: 102 },
      { t: "2026-06-23T14:03:00Z", price: 103 },
    ];
    const merged = mergeIntradayPoints(existing, incoming);
    expect(merged).toHaveLength(4);
    expect(merged[merged.length - 1]).toEqual({
      t: "2026-06-23T14:03:00Z",
      price: 103,
    });
  });
});

describe("appendSparklineTail", () => {
  it("is a no-op for empty sparkline", () => {
    const existing = [{ t: "2026-06-23T14:00:00Z", price: 100 }];
    expect(appendSparklineTail(existing, [])).toEqual(existing);
  });

  it("appends new prices with synthetic timestamps", () => {
    const existing = [{ t: "2026-06-23T14:00:00.000Z", price: 100 }];
    const merged = appendSparklineTail(existing, [101, 102]);
    expect(merged).toHaveLength(3);
    expect(merged[1]!.price).toBe(101);
    expect(merged[2]!.price).toBe(102);
    expect(new Date(merged[1]!.t).getTime()).toBeGreaterThan(
      new Date(merged[0]!.t).getTime(),
    );
  });

  it("skips duplicate tail price", () => {
    const existing = [{ t: "2026-06-23T14:00:00.000Z", price: 100 }];
    const merged = appendSparklineTail(existing, [100]);
    expect(merged).toHaveLength(1);
  });
});
