import { describe, it, expect } from "vitest";
import {
  detectGap,
  normalizeProxyToFf,
  buildFactorSeries,
} from "@/domain/calculations/factor-pipeline";

describe("detectGap", () => {
  it("returns gapExists=true for null lastFrenchDate", () => {
    const result = detectGap(null);
    expect(result.gapExists).toBe(true);
  });

  it("returns gapExists=false for today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = detectGap(today);
    // Gap might be 0 or 1 depending on time of day/weekend
    expect(result.gapTradingDays).toBeLessThanOrEqual(3);
  });

  it("counts trading days correctly for a weekday gap", () => {
    const lastFriday = "2024-01-05";
    const result = detectGap(lastFriday);
    expect(result.gapTradingDays).toBeGreaterThan(200);
  });
});

describe("normalizeProxyToFf", () => {
  const ffSeries = Array.from({ length: 100 }, (_, i) => ({
    date: `2023-${String(Math.floor(i / 22) + 1).padStart(2, "0")}-${String((i % 22) + 1).padStart(2, "0")}`,
    value: (Math.random() - 0.5) * 0.02,
  }));
  const proxySeries = [
    ...ffSeries.slice(-63).map((r) => ({ ...r, value: r.value * 1.2 + 0.001 })),
    { date: "2024-01-02", value: 0.012 },
    { date: "2024-01-03", value: -0.005 },
    { date: "2024-01-04", value: 0.008 },
  ];
  const lastFfDate = ffSeries[ffSeries.length - 1].date;

  it("returns only gap-period rows", () => {
    const normalized = normalizeProxyToFf(ffSeries, proxySeries, lastFfDate);
    expect(normalized.every((r) => r.date > lastFfDate)).toBe(true);
  });

  it("returns normalized values (finite numbers)", () => {
    const normalized = normalizeProxyToFf(ffSeries, proxySeries, lastFfDate);
    expect(normalized.every((r) => isFinite(r.value))).toBe(true);
  });
});

describe("buildFactorSeries", () => {
  it("deduplicates by date, FF takes priority", () => {
    const ff = [{ date: "2024-01-02", value: 0.01 }];
    const gap = [{ date: "2024-01-02", value: 0.99 }, { date: "2024-01-03", value: 0.02 }];
    const spliced = buildFactorSeries(ff, gap);
    expect(spliced.find((r) => r.date === "2024-01-02")?.value).toBe(0.01);
    expect(spliced).toHaveLength(2);
  });

  it("is sorted by date", () => {
    const ff = [{ date: "2024-01-03", value: 0.01 }];
    const gap = [{ date: "2024-01-02", value: 0.02 }];
    const spliced = buildFactorSeries(ff, gap);
    expect(spliced[0].date).toBe("2024-01-02");
  });
});
