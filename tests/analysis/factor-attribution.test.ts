/**
 * Tests for factor return attribution math.
 */
import { describe, it, expect } from "vitest";
import { computeDailyAttribution } from "../../src/lib/factors/attribution/daily";
import { computeCumulativeAttribution } from "../../src/lib/factors/attribution/cumulative";
import { computePeriodAttribution } from "../../src/lib/factors/attribution/period";
import type { RollingFitPoint } from "../../src/types/factors";

function makeRollingFit(date: string, beta: number): RollingFitPoint {
  return {
    date,
    fit: {
      betas: [beta],
      alpha: 0.001,
      residuals: [],
      rSquared: 0.8,
      adjRSquared: 0.79,
      tStats: [3.5],
      stdErrors: [0.1],
      alphaTStat: 1.5,
      alphaStdError: 0.0007,
      n: 252,
      k: 1,
      regularized: false,
    },
  };
}

describe("computeDailyAttribution", () => {
  it("alpha = portExcess - sum of factor contributions", () => {
    const dates = ["2024-01-02", "2024-01-03"];
    const rollingFits: RollingFitPoint[] = dates.map((d) => makeRollingFit(d, 1.2));
    const factorMap = new Map([
      ["2024-01-02", { MKT_RF: 0.01 }],
      ["2024-01-03", { MKT_RF: -0.005 }],
    ]);
    const portTotalMap = new Map([
      ["2024-01-02", 0.015],
      ["2024-01-03", -0.003],
    ]);
    const rfMap = new Map([
      ["2024-01-02", 0.0002],
      ["2024-01-03", 0.0002],
    ]);

    const daily = computeDailyAttribution(
      rollingFits,
      ["MKT_RF"],
      factorMap as Map<string, Record<string, number>>,
      portTotalMap,
      rfMap,
    );

    expect(daily).toHaveLength(2);

    for (const d of daily) {
      const factorSum = Object.values(d.byFactor).reduce((s, v) => s + v, 0);
      expect(d.alpha + factorSum).toBeCloseTo(d.portExcessReturn, 8);
    }
  });

  it("skips dates not present in portTotalMap", () => {
    const rollingFits: RollingFitPoint[] = [makeRollingFit("2024-01-02", 1.0)];
    const daily = computeDailyAttribution(
      rollingFits,
      ["MKT_RF"],
      new Map([["2024-01-02", { MKT_RF: 0.01 }]]),
      new Map(), // no port return → should skip
      new Map([["2024-01-02", 0.0001]]),
    );
    expect(daily).toHaveLength(0);
  });
});

describe("computeCumulativeAttribution", () => {
  it("cumulative values are running sums of daily values", () => {
    const daily = [
      {
        date: "2024-01-02",
        portExcessReturn: 0.01,
        rfContrib: 0.0002,
        byFactor: { MKT_RF: 0.012 } as Record<string, number>,
        alpha: -0.002,
      },
      {
        date: "2024-01-03",
        portExcessReturn: -0.005,
        rfContrib: 0.0002,
        byFactor: { MKT_RF: -0.006 } as Record<string, number>,
        alpha: 0.001,
      },
    ];

    const cum = computeCumulativeAttribution(daily as Parameters<typeof computeCumulativeAttribution>[0]);
    expect(cum[0]!.cumulativeAlpha).toBeCloseTo(-0.002, 8);
    expect(cum[1]!.cumulativeAlpha).toBeCloseTo(-0.002 + 0.001, 8);
    expect((cum[0]!.byFactor as Record<string, number>)["MKT_RF"]).toBeCloseTo(0.012, 8);
    expect((cum[1]!.byFactor as Record<string, number>)["MKT_RF"]).toBeCloseTo(0.006, 8);
  });
});

describe("computePeriodAttribution", () => {
  it("produces ITD covering all dates", () => {
    const daily = [
      {
        date: "2023-01-10",
        portExcessReturn: 0.01,
        rfContrib: 0.0002,
        byFactor: { MKT_RF: 0.009 } as Record<string, number>,
        alpha: 0.001,
      },
      {
        date: "2023-06-15",
        portExcessReturn: 0.02,
        rfContrib: 0.0003,
        byFactor: { MKT_RF: 0.018 } as Record<string, number>,
        alpha: 0.002,
      },
    ] as Parameters<typeof computePeriodAttribution>[0];

    const periods = computePeriodAttribution(daily, ["MKT_RF"], new Date("2023-12-31"));
    const itd = periods.find((p) => p.label === "ITD")!;

    expect(itd).toBeDefined();
    expect(itd.startDate).toBe("2023-01-10");
    expect(itd.alpha).toBeCloseTo(0.001 + 0.002, 8);
  });
});
