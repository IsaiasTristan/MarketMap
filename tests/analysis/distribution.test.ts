import { describe, it, expect } from "vitest";
import { skewness, excessKurtosis, returnHistogram, monthlyReturnCalendar } from "@/domain/calculations/distribution";

const normalLike = Array.from({ length: 200 }, (_, i) => {
  // Box-Muller
  const u1 = (i * 0.013 + 0.01) % 1;
  const u2 = (i * 0.037 + 0.02) % 1;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 0.01;
});

describe("skewness", () => {
  it("returns a finite number", () => {
    expect(isFinite(skewness(normalLike))).toBe(true);
  });
  it("returns NaN for short array", () => {
    expect(skewness([1, 2])).toBeNaN();
  });
});

describe("excessKurtosis", () => {
  it("returns a finite number", () => {
    expect(isFinite(excessKurtosis(normalLike))).toBe(true);
  });
});

describe("returnHistogram", () => {
  it("bins sum to input count", () => {
    const bins = returnHistogram(normalLike, 20);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(normalLike.length);
  });
  it("returns 20 bins for numBins=20", () => {
    expect(returnHistogram(normalLike, 20)).toHaveLength(20);
  });
});

describe("monthlyReturnCalendar", () => {
  const dates = ["2024-01-02", "2024-01-03", "2024-02-01"];
  const returns = [0.01, -0.005, 0.02];
  it("groups by YYYY-MM", () => {
    const cal = monthlyReturnCalendar(dates, returns);
    expect(Object.keys(cal)).toContain("2024-01");
    expect(Object.keys(cal)).toContain("2024-02");
  });
  it("compounds daily returns", () => {
    const cal = monthlyReturnCalendar(dates, returns);
    const jan = cal["2024-01"];
    expect(jan).toBeCloseTo((1 + 0.01) * (1 + (-0.005)) - 1, 6);
  });
});
