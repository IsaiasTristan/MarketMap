import { describe, expect, it } from "vitest";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { neweyWestTStat } from "@/lib/revision/backtest";
import { poolEventStudy, PRIMARY_HORIZON, type PairWeekObservation } from "@/lib/pairs/validation";

const T = PAIR_THRESHOLDS;

function iso(weekIndex: number): string {
  // Mondays every 7 days from a fixed start; good enough for span math.
  const base = Date.UTC(2023, 0, 2);
  const d = new Date(base + weekIndex * 7 * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** One fired event on pair p at week w with the given primary-horizon return. */
function ev(p: string, w: number, ret: number, extra: Partial<PairWeekObservation> = {}): PairWeekObservation {
  const base = {
    pairKey: p,
    tier: "T1",
    weekIso: iso(w),
    fired: true,
    killScreensApplied: true,
    signal: ret, // co-moving signal so IC is well-defined
    forward: { [PRIMARY_HORIZON]: ret, 13: ret },
    hedgeEff: 0.5,
    residualSharePct: 55,
    crossSector: false,
    crowdingLong: 30,
    crowdBreadthLong: null,
    valRatioPctile: 50,
    driver: "E1",
    minLegNames: 20,
    thinGap: false,
    signFlipFired: false,
    ...extra,
  };
  // firedKinds defaults to align with `fired`, unless explicitly overridden.
  return { ...base, firedKinds: extra.firedKinds ?? (base.fired ? ["UNPRICED"] : []) };
}

describe("poolEventStudy — gate", () => {
  it("blocks the headline when the sample is thin, showing what is accruing", () => {
    const obs = [ev("A", 0, 0.02), ev("A", 1, 0.03), ev("B", 2, 0.01)];
    const r = poolEventStudy(obs, { t: T });
    expect(r.headline.ready).toBe(false);
    expect(r.headline.stat).toBeNull();
    expect(r.headline.accruing.length).toBeGreaterThan(0);
    // The slice table still computes even when the headline is gated.
    expect(r.slices.length).toBeGreaterThan(0);
  });

  it("blocks on SPAN even with a large event count concentrated in one regime", () => {
    // 60 distinct pairs, hundreds of events, but all inside ~2 months.
    const obs: PairWeekObservation[] = [];
    for (let w = 0; w < 8; w++) {
      for (let p = 0; p < 60; p++) obs.push(ev(`P${p}`, w, 0.02 + 0.001 * ((p + w) % 5)));
    }
    const r = poolEventStudy(obs, { t: T });
    expect(r.totals.events).toBeGreaterThan(300);
    expect(r.headline.distinctPairs).toBeGreaterThanOrEqual(T.validationHeadlineMinPairs);
    expect(r.span.months).toBeLessThan(T.validationHeadlineMinSpanMonths);
    expect(r.headline.ready).toBe(false);
    expect(r.headline.accruing).toContain("calendar span");
  });
});

describe("poolEventStudy — clustering", () => {
  it("week-clustered effective sample is strictly below the raw event count on overlapping data", () => {
    // Many pairs per week, both fired and control within each week (the two-way
    // demeaning needs a control baseline per pair AND per week), with a
    // non-separable term so the residuals are not perfectly demeaned to zero.
    const obs: PairWeekObservation[] = [];
    let level = 0.01;
    for (let w = 0; w < 40; w++) {
      level = 0.9 * level + 0.01; // persistent, positively serially correlated
      for (let p = 0; p < 10; p++) {
        const fired = (p + w) % 2 === 0;
        obs.push(ev(`P${p}`, w, level + 0.004 * Math.sin(p + w * 1.3), { fired }));
      }
    }
    const r = poolEventStudy(obs, { t: T });
    expect(r.headline.effectiveWeeks).not.toBeNull();
    // Effective independent weeks are far fewer than the raw event count...
    expect(r.headline.effectiveWeeks!).toBeLessThan(r.totals.events);
    // ...and no larger than the number of distinct weeks.
    expect(r.headline.effectiveWeeks!).toBeLessThanOrEqual(r.totals.distinctWeeks);
  });

  it("the HAC t on overlapping weekly means is no larger than the naive t", () => {
    const weekly = Array.from({ length: 40 }, (_, i) => 0.01 + 0.008 * Math.sin(i / 2));
    const naive = neweyWestTStat(weekly, 0); // lag 0 == naive
    const hac = neweyWestTStat(weekly, PRIMARY_HORIZON - 1);
    expect(hac.tStat).not.toBeNull();
    expect(naive.tStat).not.toBeNull();
    expect(Math.abs(hac.tStat!)).toBeLessThanOrEqual(Math.abs(naive.tStat!) + 1e-9);
  });
});

describe("poolEventStudy — structure", () => {
  it("keeps Tier 2 screened and unscreened as separate slice rows", () => {
    const obs = [
      ev("A", 0, 0.02, { tier: "T2", killScreensApplied: true }),
      ev("A", 1, 0.03, { tier: "T2", killScreensApplied: false }),
    ];
    const r = poolEventStudy(obs, { t: T });
    const labels = r.slices.filter((s) => s.dimension === "tier").map((s) => s.label);
    expect(labels).toContain("Tier 2 — screened");
    expect(labels).toContain("Tier 2 — unscreened");
  });

  it("marks Leg A and E3 as insufficient (not event drivers)", () => {
    const obs = [ev("A", 0, 0.02), ev("B", 1, 0.01)];
    const r = poolEventStudy(obs, { t: T });
    const legA = r.engines.find((e) => e.engine === "LEG_A");
    const e3 = r.engines.find((e) => e.engine === "E3");
    expect(legA?.insufficient).toBe(true);
    expect(e3?.insufficient).toBe(true);
  });

  it("computes a decay curve across all horizons and a control line", () => {
    const obs = [ev("A", 0, 0.02), ev("A", 1, 0.03), ev("B", 2, 0.01)];
    const r = poolEventStudy(obs, { t: T });
    expect(r.decay.map((d) => d.horizon)).toEqual([1, 2, 4, 8, 13, 17, 21, 26]);
  });

  it("recomputes median, hit, t and IC per horizon — the columns are NOT frozen at 4W", () => {
    // Forward returns deliberately differ at 4 / 13 / 26 weeks, with a control
    // baseline and a non-separable term so every horizon's stat is distinct.
    const obs: PairWeekObservation[] = [];
    for (let w = 0; w < 30; w++) {
      for (let p = 0; p < 8; p++) {
        const fired = (p + w) % 2 === 0;
        const base = 0.004 * Math.sin(p + w * 1.1);
        const forward = {
          4: base + (fired ? 0.01 : 0),
          // Non-monotonic in the signal so the 13w IC differs from the 4w IC.
          13: base + (fired ? 0.02 * Math.cos(p * 2.1) - 0.02 : 0),
          26: base + (fired ? 0.03 * Math.cos(w) : 0),
        };
        obs.push(ev(`P${p}`, w, 0, { fired, forward, signal: forward[4] }));
      }
    }
    const r = poolEventStudy(obs, { t: T });
    const h4 = r.headline.byHorizon[4]!;
    const h13 = r.headline.byHorizon[13]!;
    const h26 = r.headline.byHorizon[26]!;
    expect(h4.median).not.toEqual(h13.median);
    expect(h4.hitRate).not.toEqual(h13.hitRate);
    expect(h4.tStat).not.toEqual(h13.tStat);
    expect(h4.ic).not.toEqual(h13.ic);
    expect(h4.excess).not.toEqual(h26.excess);
    // ...and the same holds for a slice row, not just the headline.
    const t1 = r.slices.find((s) => s.dimension === "tier" && s.label.startsWith("Tier 1"))!;
    expect(t1.byHorizon[4]!.tStat).not.toEqual(t1.byHorizon[13]!.tStat);
  });

  it("the t-statistic tests the SAME two-way-demeaned excess the row displays", () => {
    // Fired events beat their controls within each week; excess and t must
    // share a sign (the old raw-mean-vs-zero t could disagree with the excess).
    const obs: PairWeekObservation[] = [];
    for (let w = 0; w < 30; w++) {
      for (let p = 0; p < 8; p++) {
        const fired = (p + w) % 2 === 0;
        const drift = 0.05; // large positive universe drift on EVERY week
        const base = drift + 0.004 * Math.sin(p + w * 1.2);
        obs.push(ev(`P${p}`, w, 0, { fired, forward: { 4: base + (fired ? 0.01 : 0) } }));
      }
    }
    const r = poolEventStudy(obs, { t: T });
    const h = r.headline.byHorizon[4]!;
    expect(h.excess).not.toBeNull();
    expect(h.tStat).not.toBeNull();
    // Excess is net of the drift (positive), and the t agrees in sign — the
    // raw event mean (~0.055) tested against zero would have given a large,
    // misleading positive regardless of the excess.
    expect(Math.sign(h.excess!)).toBe(Math.sign(h.tStat!));
    expect(h.mean! > h.excess!).toBe(true);
  });

  it("adds an explicit unclassified row when a covariate is null", () => {
    const obs = [
      ev("A", 0, 0.02, { hedgeEff: null }),
      ev("A", 1, 0.03, { hedgeEff: null }),
      ev("B", 2, 0.01, { hedgeEff: 0.6 }),
    ];
    const r = poolEventStudy(obs, { t: T });
    const hedge = r.slices.filter((s) => s.dimension === "hedgeEff");
    expect(hedge.some((s) => s.unclassified)).toBe(true);
  });

  it("emits the three secondary event kinds, each with marginal + exclusive populations", () => {
    const obs: PairWeekObservation[] = [
      // Fires UNPRICED and E2_UNPRICED same week -> marginal counts it, exclusive drops it.
      ev("A", 0, 0.02, { firedKinds: ["UNPRICED", "E2_UNPRICED"] }),
      // Fires E2_UNPRICED only -> counted in both marginal AND exclusive.
      ev("A", 1, 0.03, { fired: false, firedKinds: ["E2_UNPRICED"] }),
      // A CONTRARY-only week.
      ev("B", 2, -0.01, { fired: false, firedKinds: ["CONTRARY"] }),
      // A control week (no kinds).
      ev("B", 3, 0.0, { fired: false, firedKinds: [] }),
    ];
    const r = poolEventStudy(obs, { t: T });
    const kinds = r.secondaryKinds.map((k) => k.kind);
    expect(kinds).toEqual(["CONTRARY", "E2_UNPRICED", "TRIANGULATED"]);
    const e2 = r.secondaryKinds.find((k) => k.kind === "E2_UNPRICED")!;
    // Marginal counts both E2_UNPRICED weeks; exclusive drops the one that also fired UNPRICED.
    expect(e2.marginal.events).toBe(2);
    expect(e2.exclusive.events).toBe(1);
    expect(e2.restatedBasis).toBe(true);
    // Each secondary carries its own three-part gate.
    expect(e2.gate.targets.effectiveWeeks).toBe(T.validationHeadlineMinWeeks);
    const contrary = r.secondaryKinds.find((k) => k.kind === "CONTRARY")!;
    expect(contrary.restatedBasis).toBe(false);
  });

  it("adds a crowding-breadth slice distinct from the basket-mean crowding slice", () => {
    const obs = [
      ev("A", 0, 0.02, { crowdBreadthLong: 5 }),
      ev("A", 1, 0.03, { crowdBreadthLong: 40 }),
      ev("B", 2, 0.01, { crowdBreadthLong: 20 }),
    ];
    const r = poolEventStudy(obs, { t: T });
    const breadth = r.slices.filter((s) => s.dimension === "crowdBreadth").map((s) => s.label);
    expect(breadth.length).toBeGreaterThan(0);
    expect(breadth).toContain(">= 30% (broadly crowded)");
  });

  it("emits basket-size and thin-gap slices bucketed by their covariates", () => {
    const obs = [
      ev("A", 0, 0.02, { minLegNames: 9, thinGap: true }),
      ev("A", 1, 0.03, { minLegNames: 9, thinGap: true }),
      ev("B", 2, 0.01, { minLegNames: 18, thinGap: false }),
      ev("C", 3, 0.01, { minLegNames: 49, thinGap: false }),
    ];
    const r = poolEventStudy(obs, { t: T });
    const size = r.slices.filter((s) => s.dimension === "basketSize").map((s) => s.label);
    expect(size).toEqual(["<= 12 names", "13-20 names", ">= 21 names"]);
    const thin = r.slices.filter((s) => s.dimension === "thinGap").map((s) => s.label);
    expect(thin).toContain("below noise floor (thin)");
    expect(thin).toContain("above noise floor");
  });
});
