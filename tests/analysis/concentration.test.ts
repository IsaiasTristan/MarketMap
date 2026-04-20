import { describe, it, expect } from "vitest";
import { hhi, effectiveN, topKConcentration } from "@/domain/calculations/concentration";

describe("hhi", () => {
  it("equals 1 for single position", () => {
    expect(hhi([1])).toBe(1);
  });
  it("equals 1/n for equal weights", () => {
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25);
  });
  it("returns 0 for empty array", () => {
    expect(hhi([])).toBe(0);
  });
});

describe("effectiveN", () => {
  it("equals n for equal weights", () => {
    expect(effectiveN([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(4);
  });
  it("equals 1 for single position", () => {
    expect(effectiveN([1])).toBeCloseTo(1);
  });
});

describe("topKConcentration", () => {
  it("returns correct top-3 share", () => {
    const weights = [0.4, 0.3, 0.2, 0.1];
    expect(topKConcentration(weights, 3)).toBeCloseTo(0.9);
  });
  it("returns 1 for k >= n", () => {
    expect(topKConcentration([0.5, 0.5], 5)).toBeCloseTo(1);
  });
});
