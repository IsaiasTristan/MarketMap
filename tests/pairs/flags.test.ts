import { describe, expect, it } from "vitest";
import { computePairFlags, pairFlagRule, gapNoiseFloorPp, isThinGap, type PairFlagInputs } from "@/lib/pairs/flags";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

const blank: PairFlagInputs = {
  isNewTopDecile: false,
  e1Gap: null,
  e1Gap4wChange: null,
  e2Gap: null,
  e2GapStepPp: null,
  relReturn1m: null,
  relReturn3m: null,
  priceRatioZ: null,
  residualSharePct: null,
  crowdingLong: null,
  crowdingShort: null,
  hedgeEff: null,
  longNameCount: null,
  shortNameCount: null,
};

describe("computePairFlags", () => {
  it("fires UNPRICED when the gap widened past the threshold and price is flat", () => {
    const flags = computePairFlags({ ...blank, e1Gap4wChange: 12, relReturn1m: 0.01 });
    expect(flags).toContain("UNPRICED");
  });
  it("does NOT fire UNPRICED when price already moved", () => {
    const flags = computePairFlags({ ...blank, e1Gap4wChange: 12, relReturn1m: 0.2 });
    expect(flags).not.toContain("UNPRICED");
  });
  it("fires CONTRARY when the gap widened but price moved the WRONG way", () => {
    const flags = computePairFlags({ ...blank, e1Gap4wChange: 12, relReturn1m: -0.2 });
    expect(flags).toContain("CONTRARY");
    expect(flags).not.toContain("UNPRICED");
  });
  it("CONTRARY and UNPRICED are disjoint by construction (band vs below-band)", () => {
    // Flat price -> UNPRICED only.
    const flat = computePairFlags({ ...blank, e1Gap4wChange: 12, relReturn1m: 0.01 });
    expect(flat).toContain("UNPRICED");
    expect(flat).not.toContain("CONTRARY");
    // Wrong-way price -> CONTRARY only. Never both, at any single relReturn1m.
    const wrong = computePairFlags({ ...blank, e1Gap4wChange: 12, relReturn1m: -0.5 });
    expect(wrong).toContain("CONTRARY");
    expect(wrong).not.toContain("UNPRICED");
  });
  it("fires E2_UNPRICED on a large E2 gap step while price stayed flat", () => {
    const flags = computePairFlags({ ...blank, e2GapStepPp: 12, relReturn1m: 0.01 });
    expect(flags).toContain("E2_UNPRICED");
  });
  it("does NOT fire E2_UNPRICED when the E2 step is below threshold", () => {
    expect(computePairFlags({ ...blank, e2GapStepPp: 3, relReturn1m: 0.01 })).not.toContain("E2_UNPRICED");
  });
  it("fires PRICED on a big 3m relative move OR a stretched ratio z", () => {
    expect(computePairFlags({ ...blank, relReturn3m: 0.2 })).toContain("PRICED");
    expect(computePairFlags({ ...blank, priceRatioZ: 2 })).toContain("PRICED");
  });
  it("fires FACTOR_BET below the residual-share threshold", () => {
    expect(computePairFlags({ ...blank, residualSharePct: 20 })).toContain("FACTOR_BET");
    expect(computePairFlags({ ...blank, residualSharePct: 80 })).not.toContain("FACTOR_BET");
  });
  it("fires crowding flags on each leg independently", () => {
    expect(computePairFlags({ ...blank, crowdingLong: 70 })).toContain("CROWDED_LONG");
    expect(computePairFlags({ ...blank, crowdingShort: 50 })).toContain("SHORT_LEG_OWNED");
  });
  it("fires NARROWING when the gap is positive but its change turned negative", () => {
    expect(computePairFlags({ ...blank, e1Gap: 10, e1Gap4wChange: -3 })).toContain("NARROWING");
  });
  it("fires ENGINES_DISAGREE on opposite-sign, non-trivial engine gaps (never suppressed)", () => {
    const flags = computePairFlags({ ...blank, e1Gap: 12, e2Gap: -9 });
    expect(flags).toContain("ENGINES_DISAGREE");
  });
  it("does not fire ENGINES_DISAGREE when one side is trivial", () => {
    expect(computePairFlags({ ...blank, e1Gap: 12, e2Gap: -1 })).not.toContain("ENGINES_DISAGREE");
  });
  it("fires LOW_HEDGE_EFF below the minimum", () => {
    expect(computePairFlags({ ...blank, hedgeEff: 0.1 })).toContain("LOW_HEDGE_EFF");
    expect(computePairFlags({ ...blank, hedgeEff: 0.5 })).not.toContain("LOW_HEDGE_EFF");
  });
  it("fires NEW on a fresh top-decile arrival", () => {
    expect(computePairFlags({ ...blank, isNewTopDecile: true })).toContain("NEW");
  });
});

describe("gapNoiseFloorPp", () => {
  it("returns the name-equivalent (200/min n) when it exceeds the pp floor", () => {
    expect(gapNoiseFloorPp(9, 49)).toBeCloseTo(200 / 9, 6); // 22.2pp (smaller leg = 9)
    expect(gapNoiseFloorPp(12, 30)).toBeCloseTo(200 / 12, 6); // 16.7pp
  });
  it("falls back to the pp floor for large baskets", () => {
    expect(gapNoiseFloorPp(49, 60)).toBe(PAIR_THRESHOLDS.thinGapMinPp); // 200/49 = 4.1 < 8
  });
  it("treats missing / non-positive counts as no name constraint (the other leg still binds)", () => {
    expect(gapNoiseFloorPp(null, null)).toBe(PAIR_THRESHOLDS.thinGapMinPp);
    // n=0 drops out, but the valid leg (20) still sets the floor at 200/20 = 10.
    expect(gapNoiseFloorPp(0, 20)).toBeCloseTo(200 / 20, 6);
  });
});

describe("isThinGap / THIN_GAP flag", () => {
  it("flags a small gap on a small basket as below the noise floor", () => {
    // +4 on n=9: floor is 22pp, so this is under a fifth of one name — thin.
    expect(isThinGap(4, 9, 49)).toBe(true);
    expect(computePairFlags({ ...blank, e1Gap: 4, longNameCount: 9, shortNameCount: 49 })).toContain("THIN_GAP");
  });
  it("does not flag a large gap on the same small basket", () => {
    // +102 on n=9 is about 4.6 names — well above the floor.
    expect(isThinGap(102, 9, 49)).toBe(false);
    expect(computePairFlags({ ...blank, e1Gap: 102, longNameCount: 9, shortNameCount: 49 })).not.toContain("THIN_GAP");
  });
  it("uses the pp floor on large baskets so a +11 gap on n=49 is not thin", () => {
    expect(isThinGap(11, 49, 60)).toBe(false);
  });
  it("returns false for a null gap", () => {
    expect(isThinGap(null, 9, 9)).toBe(false);
  });
});

describe("pairFlagRule", () => {
  it("interpolates the live thresholds into the tooltip text", () => {
    const r = pairFlagRule("UNPRICED", PAIR_THRESHOLDS);
    expect(r.rule).toContain(String(PAIR_THRESHOLDS.unpricedGapPp));
  });
  it("interpolates the noise-floor numbers into the THIN_GAP tooltip", () => {
    const r = pairFlagRule("THIN_GAP", PAIR_THRESHOLDS);
    expect(r.rule).toContain(String(PAIR_THRESHOLDS.thinGapMinPp));
    expect(r.rule).toContain(String(PAIR_THRESHOLDS.thinGapNameEquivPp));
  });
  it("marks E2_UNPRICED and TRIANGULATED as restated-basis / secondary in the tooltip", () => {
    expect(pairFlagRule("E2_UNPRICED", PAIR_THRESHOLDS).rule.toUpperCase()).toContain("RESTATED-BASIS");
    expect(pairFlagRule("TRIANGULATED", PAIR_THRESHOLDS).rule).toContain(String(PAIR_THRESHOLDS.triangulationWindowWeeks));
    expect(pairFlagRule("CONTRARY", PAIR_THRESHOLDS).rule.toLowerCase()).toContain("disjoint");
  });
});
