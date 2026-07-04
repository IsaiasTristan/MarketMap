import { describe, expect, it } from "vitest";
import {
  accumulationStreak,
  breadthGrowthFactor,
  cumulativeAccSeries,
  rSquared,
  trajectoryRankScore,
  FLOW_TRAJECTORY_CONFIG as CFG,
} from "@/domain/calculations/flow-trajectory";

describe("flow-trajectory: cumulative accumulation series (Part 1a denominator)", () => {
  it("is a plain running sum of the all-funds per-quarter net bps", () => {
    expect(cumulativeAccSeries([2, 3, -1, 4])).toEqual([2, 5, 4, 8]);
  });

  it("treats a missing (null) quarter as 0 (a gap is not a reversal)", () => {
    expect(cumulativeAccSeries([2, null, 3])).toEqual([2, 2, 5]);
    expect(cumulativeAccSeries([1, NaN, 1])).toEqual([1, 1, 2]);
  });
});

describe("flow-trajectory: rSquared (slope consistency)", () => {
  it("a perfect staircase has R² = 1", () => {
    expect(rSquared([0, 1, 2, 3, 4])).toBeCloseTo(1, 6);
  });

  it("a whipsaw has low R²", () => {
    expect(rSquared([0, 5, 0, 5, 0])).toBeLessThan(0.2);
  });

  it("returns 0 for fewer than 3 points or flat series", () => {
    expect(rSquared([0, 1])).toBe(0);
    expect(rSquared([2, 2, 2, 2])).toBe(0);
  });
});

describe("flow-trajectory: breadthGrowthFactor", () => {
  it("widening holder base scores up, clamped to 2.5", () => {
    expect(breadthGrowthFactor(2, 9)).toBe(2.5); // 1 + 7/3 = 3.33 → clamp 2.5
  });
  it("flat holders → 1.0", () => {
    expect(breadthGrowthFactor(6, 6)).toBe(1);
  });
  it("narrowing holder base scores down, clamped to 0.5", () => {
    expect(breadthGrowthFactor(10, 1)).toBe(0.5); // 1 + (-9/10) = 0.1 → clamp 0.5
  });
});

describe("flow-trajectory: accumulationStreak", () => {
  it("counts consecutive positive quarters ending at latest", () => {
    expect(accumulationStreak([2, 2, 2, 2])).toBe(4);
  });
  it("an opposite-signed quarter breaks the run", () => {
    expect(accumulationStreak([-3, 2, 2, 2])).toBe(3);
  });
  it("a flat/noise quarter breaks the active run (not accumulation)", () => {
    expect(accumulationStreak([2, 0.1, 2, 2])).toBe(2); // the 0.1 quarter ends the run
  });
  it("latest quarter within the noise floor ⇒ streak 0", () => {
    expect(accumulationStreak([2, 2, 0.1])).toBe(0);
  });
  it("distribution runs are negative", () => {
    expect(accumulationStreak([1, -2, -2])).toBe(-2);
  });
});

describe("flow-trajectory: pattern ranking (Part 1c)", () => {
  // t5 — 5-qtr staircase with a MODEST latest move must outrank a 1-qtr spike
  // with a HUGE latest move. Fails under the shipped "rank by latest active
  // move" logic (getTrajectoryGrid orders by activeBpsAvg desc).
  it("t5: durable staircase outranks a one-quarter spike", () => {
    const staircase = trajectoryRankScore({
      accSeries: cumulativeAccSeries([2, 2, 2, 2, 2]), // steady, modest latest step
      streakLength: 5,
      holdersStart: 4,
      holdersNow: 9,
    });
    const spike = trajectoryRankScore({
      accSeries: cumulativeAccSeries([0, 0, 0, 0, 40]), // flat then a huge lone jump
      streakLength: 1,
      holdersStart: 2,
      holdersNow: 3,
    });
    expect(staircase).toBeGreaterThan(spike);
  });

  // t1 — a 2-fund name with huge (participant-only) entries vs a 9-fund broad
  // build. With the all-funds denominator + breadth-growth ranking, the broad
  // build wins. Fails under the participant-denominator + latest-move logic.
  it("t1: broad multi-quarter build outranks a narrow 2-fund spike", () => {
    // Narrow: a 2-fund name. Over ALL signal funds its per-quarter bps is small
    // and it is essentially a single-quarter entry.
    const narrow = trajectoryRankScore({
      accSeries: cumulativeAccSeries([0, 0, 0, 0.6]),
      streakLength: 1,
      holdersStart: 2,
      holdersNow: 2,
    });
    // Broad: a 9-fund build across 5 quarters, holder base widening 2 → 9.
    const broad = trajectoryRankScore({
      accSeries: cumulativeAccSeries([1, 1.2, 1.1, 1.3, 1.4]),
      streakLength: 5,
      holdersStart: 2,
      holdersNow: 9,
    });
    expect(broad).toBeGreaterThan(narrow);
  });

  it("streak 0 scores 0 (no build)", () => {
    expect(trajectoryRankScore({ accSeries: [0, 0, 0], streakLength: 0, holdersStart: 3, holdersNow: 3 })).toBe(0);
  });

  it("uses config thresholds and never reads the latest-quarter magnitude directly", () => {
    // Two identical-shape staircases; the one with a bigger FINAL jump does not
    // outrank when streak/slope/breadth are equal (slope R² actually drops).
    const smoothLatest = trajectoryRankScore({
      accSeries: cumulativeAccSeries([2, 2, 2, 2]),
      streakLength: 4,
      holdersStart: 5,
      holdersNow: 5,
    });
    const spikyLatest = trajectoryRankScore({
      accSeries: cumulativeAccSeries([2, 2, 2, 20]),
      streakLength: 4,
      holdersStart: 5,
      holdersNow: 5,
    });
    expect(smoothLatest).toBeGreaterThanOrEqual(spikyLatest);
    expect(CFG.durable_min_streak).toBe(4);
  });
});
