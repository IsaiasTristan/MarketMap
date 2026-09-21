import { describe, expect, it } from "vitest";
import { evaluateReadThrough, type ReadThroughThresholds } from "@/lib/pairs/tier3";

const T: ReadThroughThresholds = { firedZ: 1.5, quietZ: 0.5, watchWeeks: 2, maxWeeks: 5 };

describe("evaluateReadThrough", () => {
  it("stays NEW when neither side fires", () => {
    const r = evaluateReadThrough({ relation: "SUBSTITUTE", scoreA: 0.2, scoreB: -0.1 }, T);
    expect(r.status).toBe("NEW");
    expect(r.firedSide).toBeNull();
    expect(r.weeksElapsed).toBe(0);
  });

  it("starts a lead (NEW, streak 1) when A fires and B is quiet", () => {
    const r = evaluateReadThrough({ relation: "SUBSTITUTE", scoreA: 2.0, scoreB: 0.1 }, T);
    expect(r.status).toBe("NEW"); // below watchWeeks
    expect(r.firedSide).toBe("A");
    expect(r.weeksElapsed).toBe(1);
  });

  it("escalates to WATCH once the lead persists watchWeeks", () => {
    const r = evaluateReadThrough(
      { relation: "SUBSTITUTE", scoreA: 2.0, scoreB: 0.1, priorFiredSide: "A", priorWeeksElapsed: 1 },
      T,
    );
    expect(r.status).toBe("WATCH");
    expect(r.weeksElapsed).toBe(2);
  });

  it("SUPPLIER_CUSTOMER only leads from A, never from B", () => {
    const fromB = evaluateReadThrough({ relation: "SUPPLIER_CUSTOMER", scoreA: 0.1, scoreB: 2.0 }, T);
    expect(fromB.status).toBe("NEW");
    expect(fromB.firedSide).toBeNull();
    const fromA = evaluateReadThrough({ relation: "SUPPLIER_CUSTOMER", scoreA: 2.0, scoreB: 0.1 }, T);
    expect(fromA.firedSide).toBe("A");
  });

  it("SUBSTITUTE confirms on a SAME-direction follower move", () => {
    const r = evaluateReadThrough(
      { relation: "SUBSTITUTE", scoreA: 2.0, scoreB: 1.8, priorFiredSide: "A", priorWeeksElapsed: 2 },
      T,
    );
    expect(r.status).toBe("CONFIRMED");
    expect(r.firedSide).toBe("A");
    expect(r.weeksElapsed).toBe(0);
  });

  it("INPUT_COST confirms only on an OPPOSITE-direction follower move", () => {
    const opposite = evaluateReadThrough(
      { relation: "INPUT_COST", scoreA: 2.0, scoreB: -1.8, priorFiredSide: "A", priorWeeksElapsed: 2 },
      T,
    );
    expect(opposite.status).toBe("CONFIRMED");

    // Same-direction move is explicitly NOT confirmation for INPUT_COST.
    const same = evaluateReadThrough(
      { relation: "INPUT_COST", scoreA: 2.0, scoreB: 1.8, priorFiredSide: "A", priorWeeksElapsed: 2 },
      T,
    );
    expect(same.status).not.toBe("CONFIRMED");
  });

  it("SUBSTITUTE does NOT confirm on an opposite-direction follower move", () => {
    const r = evaluateReadThrough(
      { relation: "SUBSTITUTE", scoreA: 2.0, scoreB: -1.8, priorFiredSide: "A", priorWeeksElapsed: 2 },
      T,
    );
    expect(r.status).not.toBe("CONFIRMED");
  });

  it("expires back to NEW when a lead runs past maxWeeks unconfirmed", () => {
    const r = evaluateReadThrough(
      { relation: "SUBSTITUTE", scoreA: 2.0, scoreB: 0.1, priorFiredSide: "A", priorWeeksElapsed: 5 },
      T,
    );
    expect(r.status).toBe("NEW");
    expect(r.weeksElapsed).toBe(0);
  });

  it("restarts the streak when the leading side switches", () => {
    const r = evaluateReadThrough(
      { relation: "SUBSTITUTE", scoreA: 0.1, scoreB: 2.0, priorFiredSide: "A", priorWeeksElapsed: 3 },
      T,
    );
    expect(r.firedSide).toBe("B");
    expect(r.weeksElapsed).toBe(1);
  });

  it("does not confirm without a prior lead even if both sides fire", () => {
    const r = evaluateReadThrough({ relation: "SUBSTITUTE", scoreA: 2.0, scoreB: 1.8, priorWeeksElapsed: 0 }, T);
    expect(r.status).not.toBe("CONFIRMED");
  });
});
