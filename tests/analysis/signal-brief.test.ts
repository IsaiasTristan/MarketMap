import { describe, expect, it } from "vitest";
import { SIGNAL_BRIEF_THRESHOLDS } from "@/lib/analysis/signal-brief/config";
import {
  buildFeed,
  classifyVerdict,
  isCrowdedDistributing,
  qualifiesAsNewIdea,
  qualifiesStasisBreak,
  severityBucket,
  type FeedCandidate,
  type VerdictInput,
} from "@/lib/analysis/signal-brief/rules";

/** Verdict input factory — a fully-covered name with no events (the quiet default). */
function name(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    gapScore: 0,
    netflowBps: 0,
    positiveTransition: false,
    negativeTransition: false,
    stasisBreak: false,
    crowdedDistributing: false,
    ...over,
  };
}

/** Feed candidate factory. */
function cand(over: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    source: "REV",
    ticker: "AAA",
    held: true,
    weight: 0.05,
    positive: true,
    kind: "NEW_LONG",
    sentence: "x",
    severity: 2,
    date: "2026-07-01",
    href: "/research?tab=queue",
    ...over,
  };
}

describe("classifyVerdict", () => {
  it("confirms only with gap at/above threshold AND flow at/above threshold", () => {
    expect(classifyVerdict(name({ gapScore: 1.0, netflowBps: 20 }))).toBe("confirm");
    expect(classifyVerdict(name({ gapScore: 0.99, netflowBps: 20 }))).toBe("quiet");
    expect(classifyVerdict(name({ gapScore: 1.0, netflowBps: 19.9 }))).toBe("quiet");
  });

  it("an active NEW_LONG substitutes for the flow leg, not for the gap leg", () => {
    expect(classifyVerdict(name({ gapScore: 1.2, netflowBps: 0, positiveTransition: true }))).toBe("confirm");
    expect(classifyVerdict(name({ gapScore: 0.5, netflowBps: 0, positiveTransition: true }))).toBe("quiet");
  });

  it("flags against at/below the gap floor", () => {
    expect(classifyVerdict(name({ gapScore: -1.0 }))).toBe("against");
    expect(classifyVerdict(name({ gapScore: -0.99 }))).toBe("quiet");
  });

  it("any negative event forces against, overriding a confirming gap+flow", () => {
    const strong = { gapScore: 2.0, netflowBps: 80 };
    expect(classifyVerdict(name({ ...strong, negativeTransition: true }))).toBe("against");
    expect(classifyVerdict(name({ ...strong, stasisBreak: true }))).toBe("against");
    expect(classifyVerdict(name({ ...strong, crowdedDistributing: true }))).toBe("against");
  });

  it("missing 13F leg → quiet (never a fabricated zero), unless an event forces against", () => {
    expect(classifyVerdict(name({ gapScore: 2.0, netflowBps: null }))).toBe("quiet");
    expect(classifyVerdict(name({ gapScore: 2.0, netflowBps: null, stasisBreak: true }))).toBe("against");
  });

  it("missing revision leg → quiet, but gap floor / events still apply", () => {
    expect(classifyVerdict(name({ gapScore: null, netflowBps: 100 }))).toBe("quiet");
    expect(classifyVerdict(name({ gapScore: null, netflowBps: 100, negativeTransition: true }))).toBe("against");
  });

  it("both legs missing → quiet", () => {
    expect(classifyVerdict(name({ gapScore: null, netflowBps: null }))).toBe("quiet");
  });

  it("honors injected thresholds (no magic numbers)", () => {
    const loose = { ...SIGNAL_BRIEF_THRESHOLDS, verdictConfirmMinGap: 0.5, verdictConfirmMinFlowBps: 5 };
    expect(classifyVerdict(name({ gapScore: 0.6, netflowBps: 6 }), loose)).toBe("confirm");
    expect(classifyVerdict(name({ gapScore: 0.6, netflowBps: 6 }))).toBe("quiet");
    const strict = { ...SIGNAL_BRIEF_THRESHOLDS, verdictAgainstMaxGap: -2.0 };
    expect(classifyVerdict(name({ gapScore: -1.5 }), strict)).toBe("quiet");
    expect(classifyVerdict(name({ gapScore: -1.5 }))).toBe("against");
  });
});

describe("crowded-distributing + stasis qualification", () => {
  it("requires the crowded quadrant AND net holders leaving", () => {
    expect(isCrowdedDistributing("crowded", -2)).toBe(true);
    expect(isCrowdedDistributing("crowded", 0)).toBe(false);
    expect(isCrowdedDistributing("early", -2)).toBe(false);
    expect(isCrowdedDistributing(null, -2)).toBe(false);
    expect(isCrowdedDistributing("crowded", null)).toBe(false);
  });

  it("stasis break needs the significance floor (boundary inclusive)", () => {
    expect(qualifiesStasisBreak(0.75)).toBe(true);
    expect(qualifiesStasisBreak(0.74)).toBe(false);
    expect(qualifiesStasisBreak(null)).toBe(false);
    const loose = { ...SIGNAL_BRIEF_THRESHOLDS, stasisBreakMinSignificance: 0.5 };
    expect(qualifiesStasisBreak(0.6, loose)).toBe(true);
  });
});

describe("severity ordering", () => {
  it("buckets: held-negative < held-positive < non-held idea < rotation", () => {
    expect(severityBucket(cand({ held: true, positive: false }))).toBe(0);
    expect(severityBucket(cand({ held: true, positive: true }))).toBe(1);
    expect(severityBucket(cand({ held: false }))).toBe(2);
    expect(severityBucket(cand({ held: false, isRotation: true, ticker: null }))).toBe(3);
  });

  it("buildFeed sorts held-negative first, strongest within a bucket", () => {
    const rows = buildFeed([
      cand({ ticker: "IDEA", held: false, kind: "NEW_LONG", gapScore: 2.0, severity: 2.0 }),
      cand({ ticker: "POS", held: true, positive: true, severity: 1.0 }),
      cand({ ticker: "NEG2", held: true, positive: false, kind: "NEW_SHORT", severity: 1.5 }),
      cand({ ticker: "NEG1", held: true, positive: false, kind: "stasis_break", source: "13F", severity: 3.0 }),
    ]);
    expect(rows.map((r) => r.ticker)).toEqual(["NEG1", "NEG2", "POS", "IDEA"]);
  });

  it("caps at feedMaxRows and honors an injected cap", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      cand({ ticker: `T${i}`, severity: 12 - i }),
    );
    expect(buildFeed(many)).toHaveLength(SIGNAL_BRIEF_THRESHOLDS.feedMaxRows);
    expect(buildFeed(many, { ...SIGNAL_BRIEF_THRESHOLDS, feedMaxRows: 3 })).toHaveLength(3);
  });

  it("dedupes per (source, ticker), keeping the more severe / more negative row", () => {
    const rows = buildFeed([
      cand({ ticker: "DUP", held: true, positive: true, severity: 5 }),
      cand({ ticker: "DUP", held: true, positive: false, kind: "NEW_SHORT", severity: 1 }),
      cand({ ticker: "DUP", source: "13F", held: true, positive: false, kind: "stasis_break", severity: 1 }),
    ]);
    // REV:DUP deduped to the negative row (bucket beats severity); 13F:DUP survives separately.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.positive).toBe(false);
    expect(rows.every((r) => r.ticker === "DUP")).toBe(true);
  });

  it("first-run empty transition set → empty feed (valid outcome)", () => {
    expect(buildFeed([])).toEqual([]);
  });
});

describe("new-idea gating + rotation extremity", () => {
  it("non-held NEW_LONG/NEW_SHORT need |gap| at/above the idea threshold; missing gap never qualifies", () => {
    expect(qualifiesAsNewIdea(cand({ held: false, kind: "NEW_LONG", gapScore: 1.5 }))).toBe(true);
    expect(qualifiesAsNewIdea(cand({ held: false, kind: "NEW_SHORT", gapScore: -1.5 }))).toBe(true);
    expect(qualifiesAsNewIdea(cand({ held: false, kind: "NEW_LONG", gapScore: 1.49 }))).toBe(false);
    expect(qualifiesAsNewIdea(cand({ held: false, kind: "NEW_LONG", gapScore: null }))).toBe(false);
  });

  it("held candidates bypass the idea gate", () => {
    expect(qualifiesAsNewIdea(cand({ held: true, kind: "NEW_LONG", gapScore: 0.1 }))).toBe(true);
  });

  it("at most one rotation row, only when it clears the extremity threshold", () => {
    const rot = (severity: number): FeedCandidate =>
      cand({ ticker: null, held: false, isRotation: true, kind: "GROUP_ROTATION", severity });
    expect(buildFeed([rot(14.9)])).toEqual([]);
    expect(buildFeed([rot(15)])).toHaveLength(1);
    expect(buildFeed([rot(20), rot(30)])).toHaveLength(1);
    const strict = { ...SIGNAL_BRIEF_THRESHOLDS, rotationRowMinAbsDiffusionPct: 25 };
    expect(buildFeed([rot(20)], strict)).toEqual([]);
  });

  it("rotation sorts last even when it is the most extreme row", () => {
    const rows = buildFeed([
      cand({ ticker: null, held: false, isRotation: true, kind: "GROUP_ROTATION", severity: 99 }),
      cand({ ticker: "HELD", held: true, positive: false, severity: 0.1 }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["NEW_LONG", "GROUP_ROTATION"]);
  });
});
