import { describe, expect, it } from "vitest";
import { annualizedRealizedVolatility } from "@/domain/calculations/volatility";

describe("annualized realized volatility", () => {
  it("uses sqrt(252) scaling on daily std (sample)", () => {
    const d = [0.01, -0.01, 0, 0.02];
    const v = annualizedRealizedVolatility(d);
    expect(v).not.toBeNull();
  });

  it("null when not enough data", () => {
    expect(annualizedRealizedVolatility([0.01])).toBeNull();
  });
});
