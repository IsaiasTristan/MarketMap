import { describe, expect, it } from "vitest";
import { BOX_REGISTRY, MIN_VALID_BOXES, type BoxKey } from "@/lib/fundamental/boxes";
import {
  recomputeDiscoveryExclusions,
  type ExcludeRowInput,
} from "@/lib/fundamental/discovery-exclude";

const ALL_KEYS = BOX_REGISTRY.map((b) => b.key);

/** A row whose box scores are given per key; unspecified keys default to `fill`. */
function mkRow(
  ticker: string,
  sector: string | null,
  subsector: string | null,
  overrides: Partial<Record<BoxKey, number | null>> = {},
  fill: number | null = 0,
): ExcludeRowInput {
  const boxScores: Partial<Record<BoxKey, number | null>> = {};
  for (const k of ALL_KEYS) boxScores[k] = k in overrides ? overrides[k]! : fill;
  return { ticker, sector, subsector, boxScores };
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

describe("recomputeDiscoveryExclusions", () => {
  it("empty exclusion set reproduces the stored composite (mean of all boxes, gate = MIN_VALID_BOXES)", () => {
    const row = mkRow("AAA", "Tech", "Software", { valuation: 2, balanceSheet: -1 }, 1);
    const out = recomputeDiscoveryExclusions([row], new Set());
    const rc = out.get("AAA")!;
    const expected = mean(ALL_KEYS.map((k) => row.boxScores![k] as number));
    expect(rc.validBoxCount).toBe(ALL_KEYS.length);
    expect(rc.composite).toBeCloseTo(expected, 12);
  });

  it("excluding a box recomputes composite as the mean of the remaining boxes", () => {
    const row = mkRow("AAA", "Tech", "Software", { valuation: 9 }, 1);
    const excluded = new Set<BoxKey>(["valuation"]);
    const out = recomputeDiscoveryExclusions([row], excluded);
    const rc = out.get("AAA")!;
    const remaining = ALL_KEYS.filter((k) => k !== "valuation").map((k) => row.boxScores![k] as number);
    expect(rc.composite).toBeCloseTo(mean(remaining), 12); // = 1, the dominant 9 dropped
    expect(rc.validBoxCount).toBe(ALL_KEYS.length - 1);
  });

  it("applies the MIN_VALID_BOXES - excludedCount gate at the strict edge", () => {
    // 1 excluded => threshold 7 of the 8 remaining.
    const excluded = new Set<BoxKey>(["dilution"]);
    const remainingKeys = ALL_KEYS.filter((k) => k !== "dilution");

    // Row A: exactly one remaining box missing => 7 valid of 8 => stays ranked.
    const rowA = mkRow("AAA", "Tech", "Software", { [remainingKeys[0]!]: null }, 1);
    // Row B: two remaining boxes missing => 6 valid => drops out (composite null).
    const rowB = mkRow("BBB", "Tech", "Software", { [remainingKeys[0]!]: null, [remainingKeys[1]!]: null }, 1);

    const out = recomputeDiscoveryExclusions([rowA, rowB], excluded);
    expect(MIN_VALID_BOXES - excluded.size).toBe(7);
    expect(out.get("AAA")!.validBoxCount).toBe(7);
    expect(out.get("AAA")!.composite).not.toBeNull();
    expect(out.get("BBB")!.validBoxCount).toBe(6);
    expect(out.get("BBB")!.composite).toBeNull();
  });

  it("re-derives deciles within peer groups and a global rank on the recomputed composite", () => {
    // Two subsectors; recomputed composite ordering driven by the non-excluded boxes.
    const rows = [
      mkRow("HI", "Tech", "Software", {}, 2),
      mkRow("LO", "Tech", "Software", {}, 0),
      mkRow("MID", "Energy", "Oil", {}, 1),
    ];
    const out = recomputeDiscoveryExclusions(rows, new Set<BoxKey>(["valuation"]));

    // Global rank: HI (2) > MID (1) > LO (0).
    expect(out.get("HI")!.rank).toBe(1);
    expect(out.get("MID")!.rank).toBe(2);
    expect(out.get("LO")!.rank).toBe(3);

    // Within the Software subsector, HI is the strongest (decile 10), LO the weakest (decile 1).
    expect(out.get("HI")!.subsectorDecile).toBe(10);
    expect(out.get("LO")!.subsectorDecile).toBe(1);
    // MID is the only name in its subsector => top decile.
    expect(out.get("MID")!.subsectorDecile).toBe(10);
  });
});
