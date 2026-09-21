import { describe, expect, it } from "vitest";
import {
  computeUnpricedGap,
  deltaSeries,
  unpricedEnginesAgree,
  stepSeries,
  triangulatedWeeks,
} from "@/lib/pairs/unpriced-gap";

describe("deltaSeries", () => {
  it("differences over N steps, leading N are null", () => {
    const d = deltaSeries([0, 1, 2, 3, 8], 4);
    expect(d.slice(0, 4).every((x) => x === null)).toBe(true);
    expect(d[4]).toBe(8); // 8 - 0
  });
});

describe("computeUnpricedGap", () => {
  it("stays uncalibrated below the minimum window and surfaces raw pp/%", () => {
    const gap = Array.from({ length: 10 }, (_, i) => i); // short history
    const rel = Array.from({ length: 10 }, () => 0);
    const r = computeUnpricedGap(gap, rel, { minWeeks: 52 });
    expect(r.calibrated).toBe(false);
    expect(r.value).toBeNull();
    expect(r.rawDeltaGapPp).not.toBeNull();
  });

  it("calibrates with enough history and is large-positive when the gap jumps but price is flat", () => {
    // 60 weeks of a mostly-flat gap, then a large widening in the final 4 weeks;
    // relative return is flat throughout, so z_own(rel) ~ 0.
    const gap: number[] = [];
    for (let i = 0; i < 56; i++) gap.push(Math.sin(i)); // small oscillation around 0
    gap.push(2, 4, 6, 12); // sharp widening
    const rel = Array.from({ length: 60 }, () => 0.0);
    const r = computeUnpricedGap(gap, rel, { minWeeks: 52, changeSteps: 4 });
    expect(r.calibrated).toBe(true);
    expect(r.value!).toBeGreaterThan(1); // signal moved, price did not
    expect(r.obsWeeks).toBeGreaterThanOrEqual(52);
  });

  it("is reduced when the price has already moved with the signal", () => {
    const gap: number[] = [];
    for (let i = 0; i < 56; i++) gap.push(Math.sin(i));
    gap.push(2, 4, 6, 12);
    const relFlat = Array.from({ length: 60 }, () => 0.0);
    const relMoved = relFlat.slice();
    relMoved[59] = 0.5; // price jumped this week too
    const unpriced = computeUnpricedGap(gap, relFlat, { minWeeks: 52 }).value!;
    const priced = computeUnpricedGap(gap, relMoved, { minWeeks: 52 }).value!;
    expect(priced).toBeLessThan(unpriced);
  });
});

describe("unpricedEnginesAgree", () => {
  it("is true only when both engines clear the threshold in the SAME direction", () => {
    expect(unpricedEnginesAgree(1.5, 2.0, 1)).toBe(true); // both positive, both >= 1
    expect(unpricedEnginesAgree(-1.5, -2.0, 1)).toBe(true); // both negative
  });
  it("is false on opposite directions even when both are large", () => {
    expect(unpricedEnginesAgree(2.0, -2.0, 1)).toBe(false);
  });
  it("is false when either engine is below the magnitude threshold", () => {
    expect(unpricedEnginesAgree(2.0, 0.4, 1)).toBe(false);
    expect(unpricedEnginesAgree(0.4, 2.0, 1)).toBe(false);
  });
  it("is false when either engine is null (never float-equality)", () => {
    expect(unpricedEnginesAgree(null, 2.0, 1)).toBe(false);
    expect(unpricedEnginesAgree(2.0, null, 1)).toBe(false);
    expect(unpricedEnginesAgree(null, null, 1)).toBe(false);
  });
});

describe("stepSeries — carry and expiry", () => {
  it("reports the most recent step and carries it forward until expiry", () => {
    // Piecewise-constant: 10 for a while, steps to 14 at index 3, then holds.
    const series = [10, 10, 10, 14, 14, 14, 14];
    const steps = stepSeries(series, 13);
    expect(steps[2]!.stepPp).toBeNull(); // no step yet
    expect(steps[3]!.stepPp).toBeCloseTo(4, 9); // +4 step landed
    expect(steps[3]!.ageWeeks).toBe(0);
    expect(steps[5]!.stepPp).toBeCloseTo(4, 9); // carried forward
    expect(steps[5]!.ageWeeks).toBe(2);
  });
  it("expires the step after maxCarryWeeks", () => {
    const series = [10, 14, 14, 14, 14, 14];
    const steps = stepSeries(series, 2); // expire after 2 weeks
    expect(steps[1]!.stepPp).toBeCloseTo(4, 9); // age 0
    expect(steps[3]!.stepPp).toBeCloseTo(4, 9); // age 2, still within carry
    expect(steps[4]!.stepPp).toBeNull(); // age 3 > 2 -> expired
    expect(steps[4]!.ageWeeks).toBeNull();
  });
  it("ignores nulls and only records a step on a real change", () => {
    const series = [null, 10, null, 10, 16, 16];
    const steps = stepSeries(series, 13);
    expect(steps[3]!.stepPp).toBeNull(); // 10 -> 10 is not a step
    expect(steps[4]!.stepPp).toBeCloseTo(6, 9); // 10 -> 16
  });
});

describe("triangulatedWeeks — window", () => {
  it("marks weeks where an E1 firing and an E2 firing land within +-window", () => {
    const e1 = [false, false, true, false, false, false];
    const e2 = [false, false, false, false, true, false]; // 2 weeks after E1
    const tri = triangulatedWeeks(e1, e2, 2);
    expect(tri[2]).toBe(true); // E1 week, E2 within +2
    expect(tri[4]).toBe(true); // E2 week, E1 within -2
  });
  it("does not triangulate when the firings are outside the window", () => {
    const e1 = [true, false, false, false, false, false];
    const e2 = [false, false, false, false, false, true]; // 5 weeks apart
    const tri = triangulatedWeeks(e1, e2, 2);
    expect(tri.every((x) => x === false)).toBe(true);
  });
});
