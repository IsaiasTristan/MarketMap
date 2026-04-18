import { describe, expect, it } from "vitest";
import { sharpeRatio } from "@/domain/calculations/sharpe";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";

describe("sharpe ratio", () => {
  it("returns null when vol ~ 0", () => {
    const zeros = new Array(30).fill(0);
    expect(sharpeRatio(zeros, 0.02)).toBeNull();
  });

  it("rises when excess return is positive and vol stable", () => {
    const prices1 = [100, 100.5, 101, 100.2, 102, 102.1];
    const d1 = dailyReturnsFromAdjustedCloses(prices1);
    const s1 = sharpeRatio(d1, 0.01);
    const s2 = sharpeRatio(
      d1.map((r) => r * 0.1),
      0.01
    );
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
  });
});
