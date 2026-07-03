import { describe, it, expect } from "vitest";
import { streakSeries } from "@/server/services/institutional/institutional-aggregate.service";

describe("streakSeries", () => {
  it("returns 0 at the earliest quarter (delta unknowable)", () => {
    expect(streakSeries([3])).toEqual([0]);
    expect(streakSeries([3, 4])[0]).toBe(0);
  });

  it("counts a monotonic accumulation run as increasing positive streak", () => {
    // deltas: +1, +2, +1 → streak +1, +2, +3
    expect(streakSeries([2, 3, 5, 6])).toEqual([0, 1, 2, 3]);
  });

  it("counts a monotonic distribution run as increasing negative streak", () => {
    // deltas: -1, -3, -1 → streak -1, -2, -3
    expect(streakSeries([9, 8, 5, 4])).toEqual([0, -1, -2, -3]);
  });

  it("resets to +1/-1 on a sign flip", () => {
    // holders 2,4,6,5,3 → deltas +2,+2,-1,-2 → streak +1,+2,-1,-2
    expect(streakSeries([2, 4, 6, 5, 3])).toEqual([0, 1, 2, -1, -2]);
  });

  it("resets the streak to 0 on a flat (zero-delta) quarter, then restarts", () => {
    // holders 3,5,5,7 → deltas +2,0,+2 → streak +1,0,+1
    expect(streakSeries([3, 5, 5, 7])).toEqual([0, 1, 0, 1]);
  });

  it("resets across a universe gap (name leaves then re-enters)", () => {
    // Present, present (accumulating), absent, present again.
    // idx3 re-entry: prev is null → delta = 5-0 > 0 → streak restarts at +1,
    // NOT continuing the prior +2 run.
    expect(streakSeries([2, 4, null, 5])).toEqual([0, 1, 0, 1]);
  });

  it("carries a positive streak across a present prior quarter", () => {
    // A gap resets, but two consecutive present accumulating quarters extend.
    // holders: null, 3, 6, 8 → idx1 first-present (prev null) → +1; then +2, +3
    expect(streakSeries([null, 3, 6, 8])).toEqual([0, 1, 2, 3]);
  });

  it("keeps streak sign aligned with sign(delta) at every present index", () => {
    const holders = [4, 7, 7, 2, 1, null, 3];
    const s = streakSeries(holders);
    for (let i = 1; i < holders.length; i++) {
      if (holders[i] == null) continue;
      const d = holders[i]! - (holders[i - 1] ?? 0);
      expect(Math.sign(s[i]!)).toBe(Math.sign(d));
    }
  });
});
