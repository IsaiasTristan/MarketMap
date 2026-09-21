import { describe, expect, it } from "vitest";
import { buildValidationControls } from "@/lib/pairs/validation-controls";
import type { PairWeekObservation } from "@/lib/pairs/validation";

function mk(
  p: string,
  w: number,
  forward4: number,
  fired: boolean,
  extra: Partial<PairWeekObservation> = {},
): PairWeekObservation {
  const base = {
    pairKey: p,
    tier: "T1",
    weekIso: `2024-${String(1 + (w % 12)).padStart(2, "0")}-${String(1 + (w % 27)).padStart(2, "0")}`,
    fired,
    killScreensApplied: true,
    signal: forward4,
    forward: { 4: forward4, 13: forward4, 26: forward4 },
    hedgeEff: 0.5,
    residualSharePct: 55,
    crossSector: false,
    crowdingLong: 3,
    crowdBreadthLong: null,
    valRatioPctile: 50,
    driver: "E1",
    minLegNames: 20,
    thinGap: false,
    signFlipFired: false,
    ...extra,
  };
  return { ...base, firedKinds: extra.firedKinds ?? (base.fired ? ["UNPRICED"] : []) };
}

/** A control-baselined universe: fired events beat control within each week. */
function universe(): PairWeekObservation[] {
  const obs: PairWeekObservation[] = [];
  for (let w = 0; w < 40; w++) {
    for (let p = 0; p < 10; p++) {
      const fired = (p + w) % 2 === 0;
      const base = 0.004 * Math.sin(p + w * 1.3);
      obs.push(mk(`P${p}`, w, base + (fired ? 0.01 : 0), fired));
    }
  }
  return obs;
}

describe("buildValidationControls", () => {
  it("known-answer produces a large positive t (the plumbing works)", () => {
    const c = buildValidationControls(universe());
    const ka = c.rows.find((r) => r.key === "known-answer")!;
    expect(ka.tStat).not.toBeNull();
    expect(ka.tStat!).toBeGreaterThan(3);
    expect(ka.excess!).toBeGreaterThan(0);
  });

  it("the placebo is far weaker than the known-answer", () => {
    const c = buildValidationControls(universe());
    const ka = c.rows.find((r) => r.key === "known-answer")!;
    const pl = c.rows.find((r) => r.key === "placebo")!;
    // A shuffled-week placebo cannot rival a signal built from the outcome.
    expect(Math.abs(pl.tStat ?? 0)).toBeLessThan(Math.abs(ka.tStat!));
  });

  it("runs the sign-flip control on the inverted events", () => {
    const obs = universe().map((o, i) => ({ ...o, signFlipFired: i % 5 === 0 }));
    const c = buildValidationControls(obs);
    const sf = c.rows.find((r) => r.key === "sign-flip")!;
    expect(sf).toBeDefined();
    expect(sf.events).toBeGreaterThan(0);
  });

  it("reports per-pair concentration and the ex-top-10 headline", () => {
    // One pair fires far more often than the rest.
    const obs: PairWeekObservation[] = [];
    for (let w = 0; w < 40; w++) {
      obs.push(mk("HOT", w, 0.02, true));
      for (let p = 0; p < 6; p++) obs.push(mk(`P${p}`, w, 0.004 * Math.sin(p + w), (p + w) % 3 === 0));
    }
    const c = buildValidationControls(obs);
    expect(c.concentration.maxEventsOnePair).toBe(40);
    expect(c.concentration.topPairKey).toBe("HOT");
    expect(c.concentration.top10SharePct).not.toBeNull();
    expect(c.concentration.top10SharePct!).toBeGreaterThan(0);
    expect(c.concentration.top10SharePct!).toBeLessThanOrEqual(100);
  });
});
