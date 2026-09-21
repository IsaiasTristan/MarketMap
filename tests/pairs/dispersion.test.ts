import { describe, expect, it } from "vitest";
import { dispersionIqr, dispersionPercentile } from "@/lib/pairs/dispersion";

describe("dispersionIqr", () => {
  it("computes the interquartile range of raw values", () => {
    // 1..9 => Q1=3, Q3=7 => IQR=4 (linear interpolation on 0-indexed positions).
    const iqr = dispersionIqr([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(iqr).toBeCloseTo(4, 6);
  });
  it("is null with fewer than 4 finite values", () => {
    expect(dispersionIqr([1, 2, null])).toBeNull();
  });
  it("REGRESSION: within-subsector z-scores collapse dispersion (must be run on raw)", () => {
    // Unit-variance z-scores => tight IQR near ~1.3; raw revisions of the same
    // names have a far larger spread. This is exactly why we forbid z here.
    const raw = [-40, -5, 0, 3, 8, 25, 60, 90];
    const zish = [-1.3, -0.6, -0.2, 0.1, 0.3, 0.7, 1.1, 1.5]; // standardised
    const iqrRaw = dispersionIqr(raw)!;
    const iqrZ = dispersionIqr(zish)!;
    expect(iqrRaw).toBeGreaterThan(iqrZ * 5);
  });
});

describe("dispersionPercentile", () => {
  it("places the latest IQR high when it is the largest in history", () => {
    const hist = [1, 1, 1, 1, 1, 1, 1, 5];
    expect(dispersionPercentile(hist)!).toBeGreaterThan(80);
  });
  it("is null with a shallow history", () => {
    expect(dispersionPercentile([1, 2, 3])).toBeNull();
  });
});
