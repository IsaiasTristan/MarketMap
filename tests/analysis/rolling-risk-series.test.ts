import { describe, it, expect } from "vitest";
import {
  decimateSeries,
  rollingAnnualizedVolatilitySeries,
  rollingVolSparkline,
  rollingSharpeSparkline,
} from "@/domain/calculations/rolling-risk-series";
import {
  holdingsHorizonStartDateIso,
  isValidHoldingsHorizon,
  HOLDINGS_HORIZONS,
} from "@/server/services/pnl.service";

describe("rolling-risk-series", () => {
  const returns = Array.from({ length: 300 }, (_, i) =>
    0.001 * Math.sin(i / 10),
  );

  it("decimateSeries caps output length", () => {
    const long = Array.from({ length: 200 }, (_, i) => i);
    expect(decimateSeries(long, 60).length).toBe(60);
  });

  it("rollingAnnualizedVolatilitySeries is NaN before window fills", () => {
    const series = rollingAnnualizedVolatilitySeries(returns, 21);
    expect(Number.isNaN(series[19])).toBe(true);
    expect(Number.isFinite(series[20])).toBe(true);
  });

  it("rollingVolSparkline returns decimated finite values", () => {
    const spark = rollingVolSparkline(returns, 21, 252, 60);
    expect(spark.length).toBeGreaterThan(0);
    expect(spark.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("rollingSharpeSparkline returns decimated finite values", () => {
    const spark = rollingSharpeSparkline(returns, 63, 0.04, 252, 60);
    expect(spark.length).toBeGreaterThan(0);
    expect(spark.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("holdings horizon maps", () => {
  it("validates known horizons", () => {
    for (const h of HOLDINGS_HORIZONS) {
      expect(isValidHoldingsHorizon(h)).toBe(true);
    }
    expect(isValidHoldingsHorizon("1D")).toBe(false);
  });

  it("holdingsHorizonStartDateIso steps back calendar days", () => {
    const ref = new Date("2026-06-22T12:00:00Z");
    const start10 = holdingsHorizonStartDateIso("10D", ref);
    expect(start10).toBe("2026-06-08");
    const start3m = holdingsHorizonStartDateIso("3M", ref);
    expect(start3m).toBe("2026-03-24");
  });
});
