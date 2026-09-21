import { describe, expect, it } from "vitest";
import { capByLeg, type LegPair } from "@/lib/pairs/rank-display";

const p = (longKey: string, shortKey: string): LegPair => ({ longKey, shortKey });

describe("capByLeg", () => {
  it("caps how many times a single leg appears, in list order", () => {
    const rows = [
      p("Airlines", "Retail"),
      p("Airlines", "Software"),
      p("Airlines", "Banks"), // 3rd Airlines long — over cap 2
      p("Semis", "Airlines"), // Airlines on the SHORT side — also over cap
      p("Banks", "Insurance"),
    ];
    const { shown, hidden, hiddenByLeg } = capByLeg(rows, 2);
    expect(shown.map((r) => `${r.longKey}/${r.shortKey}`)).toEqual([
      "Airlines/Retail",
      "Airlines/Software",
      "Banks/Insurance",
    ]);
    expect(hidden).toHaveLength(2);
    expect(hiddenByLeg.get("Airlines")).toBe(2);
  });

  it("counts either side toward a leg's tally", () => {
    const rows = [p("A", "B"), p("C", "A"), p("A", "D")];
    const { shown, hidden } = capByLeg(rows, 1);
    // A appears in row 1 (long); rows 2 and 3 both reuse A and are capped.
    expect(shown).toHaveLength(1);
    expect(hidden).toHaveLength(2);
  });

  it("disables capping for a non-positive cap", () => {
    const rows = [p("A", "B"), p("A", "C"), p("A", "D")];
    const { shown, hidden } = capByLeg(rows, 0);
    expect(shown).toHaveLength(3);
    expect(hidden).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const rows = [p("A", "B"), p("A", "C")];
    const copy = [...rows];
    capByLeg(rows, 1);
    expect(rows).toEqual(copy);
  });
});
