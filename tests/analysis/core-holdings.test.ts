import { describe, expect, it } from "vitest";
import {
  fundMedianTenure,
  isQualifiedTrimOrExit,
  scoreEndorsement,
  stasisBreakSignificance,
  tenureMult,
  tenureSeries,
  type Voter,
  CORE_HOLDINGS_CONFIG as CFG,
} from "@/domain/calculations/core-holdings";

const voter = (o: Partial<Voter> & { fundId: string; tenureMult: number }): Voter => ({
  tenure: 8,
  censored: false,
  weightBps: 100,
  isElite: false,
  category: "Value",
  ...o,
});

describe("core-holdings: tenure series (Part 3a)", () => {
  it("counts consecutive held quarters", () => {
    const t = tenureSeries([false, false, true, true, true]);
    expect(t.map((x) => x.tenure)).toEqual([0, 0, 1, 2, 3]);
  });

  it("left-censors a run that reaches the earliest ingested quarter (index 0)", () => {
    const t = tenureSeries([true, true, true]);
    expect(t[2]).toEqual({ tenure: 3, censored: true });
  });

  it("a fund entering mid-history is NOT censored (a real NEW there)", () => {
    const t = tenureSeries([false, false, true, true]);
    expect(t[3]).toEqual({ tenure: 2, censored: false });
  });

  it("an exit resets tenure; re-entry restarts at 1", () => {
    const t = tenureSeries([false, true, true, false, true]);
    expect(t.map((x) => x.tenure)).toEqual([0, 1, 2, 0, 1]);
  });
});

describe("core-holdings: fund-relative long hold (Part 3b)", () => {
  // high-turnover fund (median 1.5q) holding 4q ⇒ mult ~2.7, a long-hold voter.
  it("high-turnover fund holding 4q vs median 1.5q ⇒ mult 2.67, votes", () => {
    const mult = tenureMult(4, 1.5);
    expect(mult).toBeCloseTo(2.67, 2);
    expect(mult).toBeGreaterThanOrEqual(CFG.long_hold_mult);
  });

  // low-turnover fund (median 9q) holding 6q ⇒ 0.67, NOT a voter.
  it("low-turnover fund holding 6q vs median 9q ⇒ mult 0.67, no vote", () => {
    const mult = tenureMult(6, 9);
    expect(mult).toBeCloseTo(0.67, 2);
    expect(mult).toBeLessThan(CFG.long_hold_mult);
  });

  // censored ≥10q with median 4q ⇒ mult computed on the floor value 10.
  it("censored ≥10q with median 4q ⇒ mult on 10, censored flag preserved", () => {
    const t = tenureSeries(Array(10).fill(true)); // run reaches index 0 → censored
    const last = t[9]!;
    expect(last.censored).toBe(true);
    expect(tenureMult(last.tenure, 4)).toBe(2.5);
  });

  it("fundMedianTenure flags a floor estimate when >30% of the book is censored", () => {
    const book = [
      { tenure: 10, censored: true },
      { tenure: 8, censored: true },
      { tenure: 4, censored: false },
      { tenure: 2, censored: false },
    ];
    const { median, floorEstimate } = fundMedianTenure(book);
    expect(median).toBe(6); // (4+8)/2
    expect(floorEstimate).toBe(true); // 50% censored > 30%
  });
});

describe("core-holdings: endorsement + validity gates (Part 3c)", () => {
  it("sums capped tenure_mult × weight × elite-binary quality weight", () => {
    const holders: Voter[] = [
      voter({ fundId: "a", tenureMult: 2, weightBps: 100, isElite: true, category: "Value" }),
      voter({ fundId: "b", tenureMult: 5, weightBps: 50, isElite: false, category: "Growth/Quality" }), // capped at 4
    ];
    const r = scoreEndorsement(holders);
    // a: min(2,4)*100*1.5 = 300 ; b: min(5,4)*50*1.0 = 200
    expect(r.endorsementScore).toBe(500);
    expect(r.eliteVoters).toBe(1);
  });

  it("a 6-fund single-category clone cohort fails the ≥2-category gate", () => {
    const holders: Voter[] = Array.from({ length: 6 }, (_, i) =>
      voter({ fundId: `f${i}`, tenureMult: 3, weightBps: 200, category: "TMT" }),
    );
    const r = scoreEndorsement(holders);
    expect(r.longHoldVoters).toBe(6);
    expect(r.distinctCategories).toBe(1);
    expect(r.valid).toBe(false);
  });

  it("passes validity with ≥5 voters across ≥2 categories", () => {
    const cats = ["Value", "Growth/Quality", "TMT", "Healthcare", "Energy"];
    const holders: Voter[] = cats.map((c, i) => voter({ fundId: `f${i}`, tenureMult: 2, weightBps: 100, category: c }));
    const r = scoreEndorsement(holders);
    expect(r.valid).toBe(true);
    expect(r.distinctCategories).toBe(5);
  });

  it("excludes holders below the long-hold multiple or weight floor", () => {
    const holders: Voter[] = [
      voter({ fundId: "lo-mult", tenureMult: 1.0, weightBps: 500 }), // below long_hold_mult
      voter({ fundId: "lo-wt", tenureMult: 3, weightBps: 10 }), // below min_entry_bps
    ];
    const r = scoreEndorsement(holders);
    expect(r.longHoldVoters).toBe(0);
    expect(r.endorsementScore).toBe(0);
  });
});

describe("core-holdings: stasis break (Part 3d)", () => {
  it("a 22% trim by a long-tenure holder is a qualified break", () => {
    expect(isQualifiedTrimOrExit(1000, 780, false)).toBe(true); // -22% > 10% deadzone
  });
  it("a dribble within the deadzone is not a break", () => {
    expect(isQualifiedTrimOrExit(1000, 950, false)).toBe(false); // -5%
  });
  it("an exit is always a qualified break", () => {
    expect(isQualifiedTrimOrExit(1000, 0, true)).toBe(true);
  });
  it("significance scales with the departing fund's tenure_mult", () => {
    expect(stasisBreakSignificance(4)).toBe(1); // capped
    expect(stasisBreakSignificance(2)).toBe(0.5);
    expect(stasisBreakSignificance(1)).toBeLessThan(stasisBreakSignificance(3));
  });
});
