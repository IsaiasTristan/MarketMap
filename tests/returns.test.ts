import { describe, expect, it } from "vitest";
import {
  dailyReturnsFromAdjustedCloses,
  totalReturnForHorizon,
} from "@/domain/calculations/returns";

describe("daily returns", () => {
  it("matches (P_t/P_t-1)-1", () => {
    const prices = [100, 110, 99];
    const d = dailyReturnsFromAdjustedCloses(prices);
    expect(d[0]!).toBeCloseTo(0.1, 6);
    expect(d[1]!).toBeCloseTo(-0.1, 6);
  });
});

describe("horizon total return", () => {
  it("1D = last bar return", () => {
    const p = [10, 10, 10, 10, 20];
    const d = dailyReturnsFromAdjustedCloses(p);
    const t = totalReturnForHorizon(d, "D1");
    expect(t).toBeCloseTo(1, 6);
  });
});
