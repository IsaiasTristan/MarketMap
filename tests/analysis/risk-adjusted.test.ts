import { describe, it, expect } from "vitest";
import {
  maxDrawdown,
  drawdownSeries,
  calmarRatio,
  sortinoRatio,
  upCaptureRatio,
  downCaptureRatio,
} from "@/domain/calculations/risk-adjusted";

const flatReturns = [0.01, -0.01, 0.02, -0.02, 0.01];
const crashReturns = [0.05, 0.03, -0.15, 0.02, -0.20, 0.10];

describe("maxDrawdown", () => {
  it("returns 0 for empty array", () => {
    expect(maxDrawdown([])).toBe(0);
  });
  it("returns negative value for a crash series", () => {
    const dd = maxDrawdown(crashReturns);
    expect(dd).toBeLessThan(0);
    expect(dd).toBeGreaterThan(-1);
  });
  it("returns 0 for all positive returns", () => {
    expect(maxDrawdown([0.01, 0.02, 0.03])).toBe(0);
  });
});

describe("drawdownSeries", () => {
  it("length matches input", () => {
    expect(drawdownSeries(flatReturns)).toHaveLength(flatReturns.length);
  });
  it("all values <= 0", () => {
    const dd = drawdownSeries(crashReturns);
    expect(dd.every((v) => v <= 0)).toBe(true);
  });
});

describe("sortinoRatio", () => {
  it("returns NaN for empty", () => {
    expect(sortinoRatio([], 0.05)).toBeNaN();
  });
  it("returns a finite number for valid input", () => {
    expect(isFinite(sortinoRatio([0.01, -0.02, 0.03, -0.01, 0.02], 0.05))).toBe(true);
  });
});

describe("capture ratios", () => {
  const port = [0.02, -0.01, 0.03, -0.02, 0.01];
  const bench = [0.015, -0.02, 0.025, -0.015, 0.005];

  it("up-capture is finite", () => {
    expect(isFinite(upCaptureRatio(port, bench))).toBe(true);
  });
  it("down-capture is finite", () => {
    expect(isFinite(downCaptureRatio(port, bench))).toBe(true);
  });
});
