import { describe, expect, it } from "vitest";
import { CONFLUENCE_THRESHOLDS } from "@/lib/analysis/confluence/config";
import {
  buildReadSentence,
  classifyFlows,
  classifyFundamentals,
  classifyRevisions,
  classifyStage,
  compareConfluenceRows,
  stageChipLabel,
  STAGE_ORDER,
  type ReadSentenceInput,
  type SignalState,
  type StackStates,
  type Stage,
} from "@/lib/analysis/confluence/rules";

const t = CONFLUENCE_THRESHOLDS;

function stack(over: Partial<StackStates> = {}): StackStates {
  return { f: "NEUTRAL", r: "NEUTRAL", f13: "NEUTRAL", ...over };
}

function readInput(over: Partial<ReadSentenceInput> = {}): ReadSentenceInput {
  return {
    stage: "FULL_STACK",
    direction: "LONG",
    f: "LONG",
    r: "LONG",
    f13: "LONG",
    decile: 9,
    gapScore: 1.8,
    netflowBps: 12,
    lifecycleStage: "DURABLE",
    trapFlag: false,
    crowded: false,
    inExitCluster: false,
    ...over,
  };
}

// ─── State mapping ───────────────────────────────────────────────────────────

describe("classifyFundamentals", () => {
  it("decile boundaries: 9→LONG, 8→NEUTRAL, 2→SHORT, 3→NEUTRAL", () => {
    const f = (d: number) => classifyFundamentals({ covered: true, subsectorDecile: d, sectorDecile: null });
    expect(f(9)).toBe("LONG");
    expect(f(10)).toBe("LONG");
    expect(f(8)).toBe("NEUTRAL");
    expect(f(2)).toBe("SHORT");
    expect(f(1)).toBe("SHORT");
    expect(f(3)).toBe("NEUTRAL");
  });

  it("falls back subsector → sector decile", () => {
    expect(classifyFundamentals({ covered: true, subsectorDecile: null, sectorDecile: 10 })).toBe("LONG");
    expect(classifyFundamentals({ covered: true, subsectorDecile: 5, sectorDecile: 10 })).toBe("NEUTRAL");
  });

  it("covered with both deciles null → NEUTRAL; uncovered → NO_COVERAGE", () => {
    expect(classifyFundamentals({ covered: true, subsectorDecile: null, sectorDecile: null })).toBe("NEUTRAL");
    expect(classifyFundamentals({ covered: false, subsectorDecile: 10, sectorDecile: 10 })).toBe("NO_COVERAGE");
  });

  it("honors injected thresholds", () => {
    const loose = { ...t, fundLongMinDecile: 8 };
    expect(classifyFundamentals({ covered: true, subsectorDecile: 8, sectorDecile: null }, loose)).toBe("LONG");
    expect(classifyFundamentals({ covered: true, subsectorDecile: 8, sectorDecile: null })).toBe("NEUTRAL");
  });
});

describe("classifyRevisions", () => {
  it("maps side; anything else NEUTRAL; uncovered NO_COVERAGE", () => {
    expect(classifyRevisions({ covered: true, side: "LONG" })).toBe("LONG");
    expect(classifyRevisions({ covered: true, side: "SHORT" })).toBe("SHORT");
    expect(classifyRevisions({ covered: true, side: null })).toBe("NEUTRAL");
    expect(classifyRevisions({ covered: true, side: "WATCH" })).toBe("NEUTRAL");
    expect(classifyRevisions({ covered: false, side: "LONG" })).toBe("NO_COVERAGE");
  });
});

describe("classifyFlows", () => {
  const base = { covered: true, netflowBps: 0, lifecycleStage: null as string | null, inExitCluster: false };

  it("bps boundaries: +5→LONG, +4.9→NEUTRAL, −5→SHORT, −4.9→NEUTRAL", () => {
    expect(classifyFlows({ ...base, netflowBps: 5 })).toBe("LONG");
    expect(classifyFlows({ ...base, netflowBps: 4.9 })).toBe("NEUTRAL");
    expect(classifyFlows({ ...base, netflowBps: -5 })).toBe("SHORT");
    expect(classifyFlows({ ...base, netflowBps: -4.9 })).toBe("NEUTRAL");
  });

  it("lifecycle FORMING/DURABLE → LONG at zero bps; SPIKE/CORE → NEUTRAL", () => {
    expect(classifyFlows({ ...base, lifecycleStage: "FORMING" })).toBe("LONG");
    expect(classifyFlows({ ...base, lifecycleStage: "DURABLE" })).toBe("LONG");
    expect(classifyFlows({ ...base, lifecycleStage: "SPIKE" })).toBe("NEUTRAL");
    expect(classifyFlows({ ...base, lifecycleStage: "CORE" })).toBe("NEUTRAL");
  });

  it("BROKEN / exit cluster → SHORT, and SHORT wins over a positive-bps long read", () => {
    expect(classifyFlows({ ...base, lifecycleStage: "BROKEN" })).toBe("SHORT");
    expect(classifyFlows({ ...base, inExitCluster: true })).toBe("SHORT");
    // Both fire: distribution reads dominate.
    expect(classifyFlows({ ...base, lifecycleStage: "BROKEN", netflowBps: 12 })).toBe("SHORT");
    expect(classifyFlows({ ...base, inExitCluster: true, netflowBps: 12 })).toBe("SHORT");
  });

  it("null bps with no lifecycle read → NEUTRAL; uncovered → NO_COVERAGE", () => {
    expect(classifyFlows({ ...base, netflowBps: null })).toBe("NEUTRAL");
    expect(classifyFlows({ ...base, covered: false })).toBe("NO_COVERAGE");
  });

  it("honors injected thresholds", () => {
    const spec = { ...t, flowLongMinBps: 20 };
    expect(classifyFlows({ ...base, netflowBps: 12 }, spec)).toBe("NEUTRAL");
    expect(classifyFlows({ ...base, netflowBps: 12 })).toBe("LONG");
  });
});

// ─── Stage classification ────────────────────────────────────────────────────

describe("classifyStage", () => {
  it("zero non-neutral → excluded (stage null), including all-NO_COVERAGE", () => {
    expect(classifyStage(stack(), false).stage).toBeNull();
    expect(
      classifyStage(stack({ f: "NO_COVERAGE", r: "NO_COVERAGE", f13: "NO_COVERAGE" }), false).stage,
    ).toBeNull();
  });

  it("all three agree → FULL_STACK depth 3, both directions", () => {
    expect(classifyStage(stack({ f: "LONG", r: "LONG", f13: "LONG" }), false)).toEqual({
      stage: "FULL_STACK",
      direction: "LONG",
      stackDepth: 3,
      singleSource: null,
    });
    expect(classifyStage(stack({ f: "SHORT", r: "SHORT", f13: "SHORT" }), false)).toEqual({
      stage: "FULL_STACK",
      direction: "SHORT",
      stackDepth: 3,
      singleSource: null,
    });
  });

  it("crowded demotes LONG full stacks only", () => {
    expect(classifyStage(stack({ f: "LONG", r: "LONG", f13: "LONG" }), true).stage).toBe("CROWDED");
    expect(classifyStage(stack({ f: "SHORT", r: "SHORT", f13: "SHORT" }), true).stage).toBe("FULL_STACK");
    // Crowded never touches non-full stacks.
    expect(classifyStage(stack({ f: "LONG", r: "LONG" }), true).stage).toBe("PLUS_REVISIONS");
  });

  it("each two-source pair gets its distinct stage, both directions", () => {
    expect(classifyStage(stack({ f: "LONG", r: "LONG" }), false).stage).toBe("PLUS_REVISIONS");
    expect(classifyStage(stack({ r: "SHORT", f13: "SHORT" }), false).stage).toBe("R_PLUS_13F");
    expect(classifyStage(stack({ f: "SHORT", f13: "SHORT" }), false).stage).toBe("F_PLUS_13F");
    const r = classifyStage(stack({ r: "SHORT", f13: "SHORT" }), false);
    expect(r.direction).toBe("SHORT");
    expect(r.stackDepth).toBe(2);
  });

  it("NO_COVERAGE behaves exactly like NEUTRAL for staging", () => {
    const withNeutral = classifyStage(stack({ f: "LONG", r: "LONG", f13: "NEUTRAL" }), false);
    const withNoCov = classifyStage(stack({ f: "LONG", r: "LONG", f13: "NO_COVERAGE" }), false);
    expect(withNoCov).toEqual(withNeutral);
  });

  it("single-source stages carry the firing source", () => {
    expect(classifyStage(stack({ f: "LONG" }), false)).toEqual({
      stage: "SINGLE",
      direction: "LONG",
      stackDepth: 1,
      singleSource: "F",
    });
    expect(classifyStage(stack({ r: "SHORT" }), false).singleSource).toBe("R");
    expect(classifyStage(stack({ f13: "LONG" }), false).singleSource).toBe("F13");
  });

  it("2v1 conflict → CONFLICT, majority direction, depth = majority count", () => {
    const r = classifyStage(stack({ f: "LONG", r: "LONG", f13: "SHORT" }), false);
    expect(r).toEqual({ stage: "CONFLICT", direction: "LONG", stackDepth: 2, singleSource: null });
    const s = classifyStage(stack({ f: "SHORT", r: "SHORT", f13: "LONG" }), false);
    expect(s.direction).toBe("SHORT");
  });

  it("1v1 conflict tie → direction null, depth 1", () => {
    const r = classifyStage(stack({ f: "LONG", f13: "SHORT" }), false);
    expect(r).toEqual({ stage: "CONFLICT", direction: null, stackDepth: 1, singleSource: null });
  });
});

describe("stage chip labels + order", () => {
  it("labels every stage; SINGLE by source", () => {
    expect(stageChipLabel("FULL_STACK", null)).toBe("FULL STACK");
    expect(stageChipLabel("PLUS_REVISIONS", null)).toBe("+REVISIONS");
    expect(stageChipLabel("R_PLUS_13F", null)).toBe("R+13F");
    expect(stageChipLabel("F_PLUS_13F", null)).toBe("F+13F");
    expect(stageChipLabel("SINGLE", "F")).toBe("FUND ONLY");
    expect(stageChipLabel("SINGLE", "R")).toBe("REV ONLY");
    expect(stageChipLabel("SINGLE", "F13")).toBe("13F ONLY");
    expect(stageChipLabel("SINGLE", null)).toBe("SINGLE"); // funnel segment (no per-row source)
  });

  it("STAGE_ORDER covers all stages exactly once", () => {
    const all: Stage[] = ["FULL_STACK", "CROWDED", "PLUS_REVISIONS", "R_PLUS_13F", "F_PLUS_13F", "SINGLE", "CONFLICT"];
    expect([...STAGE_ORDER].sort()).toEqual(all.sort());
  });
});

// ─── Ranking ─────────────────────────────────────────────────────────────────

describe("compareConfluenceRows", () => {
  it("depth desc, then |gap| desc (negative gaps count), null gap last, ticker tiebreak", () => {
    const rows = [
      { ticker: "NULLGAP", stackDepth: 3, gapScore: null },
      { ticker: "NEG", stackDepth: 3, gapScore: -2.1 },
      { ticker: "POS", stackDepth: 3, gapScore: 1.8 },
      { ticker: "DEEP", stackDepth: 2, gapScore: 9.9 },
      { ticker: "AAA", stackDepth: 3, gapScore: 1.8 },
    ].sort(compareConfluenceRows);
    expect(rows.map((r) => r.ticker)).toEqual(["NEG", "AAA", "POS", "NULLGAP", "DEEP"]);
  });
});

// ─── READ sentences ──────────────────────────────────────────────────────────

describe("buildReadSentence", () => {
  it("full stack long reads in causal order with carried numbers", () => {
    const s = buildReadSentence(readInput());
    expect(s).toContain("FUNDAMENTALS INFLECTED (D9)");
    expect(s).toContain("ANALYSTS CHASING (GAP +1.8σ UNPRICED)");
    expect(s).toContain("FUNDS ACCUMULATING (DURABLE, +12BPS)");
  });

  it("trap flag rides along on the fundamentals phrase", () => {
    expect(buildReadSentence(readInput({ trapFlag: true }))).toContain("TRAP FLAG, CHEAP FOR A REASON?");
  });

  it("crowded and conflict append their suffixes", () => {
    expect(buildReadSentence(readInput({ stage: "CROWDED", crowded: true }))).toContain(
      "CROWDED (BREADTH ≥ P75), LATE-STAGE",
    );
    expect(
      buildReadSentence(readInput({ stage: "CONFLICT", f13: "SHORT", netflowBps: -8, lifecycleStage: "BROKEN" })),
    ).toContain("CONFLICT: VERIFY WHICH SIDE IS STALE");
  });

  it("the sweet-spot sequence phrase: funds not in yet", () => {
    const s = buildReadSentence(
      readInput({ stage: "PLUS_REVISIONS", f13: "NEUTRAL", netflowBps: 0, lifecycleStage: null }),
    );
    expect(s).toContain("FUNDS NOT IN YET");
  });

  it("exit cluster wording on the short flow leg", () => {
    const s = buildReadSentence(
      readInput({ f13: "SHORT", inExitCluster: true, netflowBps: -3, direction: "SHORT" }),
    );
    expect(s).toContain("CONVICTION EXIT CLUSTER");
  });

  it("no internal engine codenames in any state permutation", () => {
    const states: SignalState[] = ["LONG", "SHORT", "NEUTRAL", "NO_COVERAGE"];
    for (const f of states)
      for (const r of states)
        for (const f13 of states) {
          const s = buildReadSentence(readInput({ f, r, f13 }));
          expect(s).not.toMatch(/engine\s*[123]/i);
        }
  });
});
