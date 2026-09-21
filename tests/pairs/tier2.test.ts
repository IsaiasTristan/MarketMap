import { describe, expect, it } from "vitest";
import { selectTopBottomK, type Tier2Member } from "@/lib/pairs/tier2";

const m = (
  ticker: string,
  score: number,
  kills?: { long?: string; short?: string },
): Tier2Member => ({
  ticker,
  score,
  longKillReason: kills?.long ?? null,
  shortKillReason: kills?.short ?? null,
});

describe("selectTopBottomK", () => {
  it("takes top-k long and bottom-k short from all names when nothing is killed", () => {
    const r = selectTopBottomK([m("A", 5), m("B", 4), m("C", 3), m("D", 2), m("E", 1), m("F", 0)], 2)!;
    expect(r.longLeg).toEqual(["A", "B"]);
    expect(r.shortLeg).toEqual(["F", "E"]); // weakest first
    expect(r.killed).toEqual([]);
  });

  it("removes a trap name from the LONG leg only and records it killed", () => {
    // A is the top scorer but trap-flagged: B and C become the long leg.
    const r = selectTopBottomK([m("A", 5, { long: "TRAP" }), m("B", 4), m("C", 3), m("D", 2), m("E", 1)], 2)!;
    expect(r.longLeg).toEqual(["B", "C"]);
    expect(r.shortLeg).toEqual(["E", "D"]);
    expect(r.killed).toEqual([{ ticker: "A", side: "LONG", score: 5, reason: "TRAP" }]);
  });

  it("keeps an accumulating name longable but bars it from the SHORT leg", () => {
    // F is the weakest (natural short) but Engine-3 accumulating: E takes its place.
    const r = selectTopBottomK(
      [m("A", 5), m("B", 4), m("C", 3), m("D", 2), m("E", 1), m("F", 0, { short: "ACCUM" })],
      2,
    )!;
    expect(r.longLeg).toEqual(["A", "B"]);
    expect(r.shortLeg).toEqual(["E", "D"]);
    expect(r.killed).toEqual([{ ticker: "F", side: "SHORT", score: 0, reason: "ACCUM" }]);
  });

  it("does NOT bar a strong accumulating name from going long", () => {
    // A accumulating + top score => still long (short kill is irrelevant on the long side).
    const r = selectTopBottomK([m("A", 5, { short: "ACCUM" }), m("B", 4), m("C", 1)], 1)!;
    expect(r.longLeg).toEqual(["A"]);
    expect(r.shortLeg).toEqual(["C"]);
    expect(r.killed).toEqual([]);
  });

  it("returns null when a leg cannot be filled to k after kills", () => {
    // 3 names, top killed long => only B, C eligible long; need 2 long + 2 short disjoint.
    expect(selectTopBottomK([m("A", 5, { long: "TRAP" }), m("B", 4), m("C", 3)], 2)).toBeNull();
  });

  it("breaks ties deterministically on ticker (score desc, ticker asc)", () => {
    const r = selectTopBottomK([m("D", 1), m("A", 1), m("C", 1), m("B", 1)], 1)!;
    expect(r.longLeg).toEqual(["A"]);
    expect(r.shortLeg).toEqual(["D"]);
  });

  it("skips non-finite scores", () => {
    const r = selectTopBottomK([m("A", 5), m("B", NaN), m("C", 3), m("D", 1)], 1)!;
    expect(r.longLeg).toEqual(["A"]);
    expect(r.shortLeg).toEqual(["D"]);
  });

  it("returns null for k <= 0", () => {
    expect(selectTopBottomK([m("A", 1), m("B", 2)], 0)).toBeNull();
  });

  it("keeps long and short legs disjoint on tiny universes", () => {
    const r = selectTopBottomK([m("A", 2), m("B", 1)], 1)!;
    expect(r.longLeg).toEqual(["A"]);
    expect(r.shortLeg).toEqual(["B"]);
    expect(new Set([...r.longLeg, ...r.shortLeg]).size).toBe(2);
  });
});
