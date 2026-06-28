import { describe, expect, it } from "vitest";
import {
  buildDiscoverySummary,
  type DiscoverySummaryInput,
} from "@/lib/fundamental/discovery-summary";

function row(partial: Partial<DiscoverySummaryInput>): DiscoverySummaryInput {
  return {
    sector: "sector" in partial ? partial.sector ?? null : "TECH",
    subsector: "subsector" in partial ? partial.subsector ?? null : "Software",
    composite: partial.composite ?? 1,
    subsectorDecile: partial.subsectorDecile ?? 8,
    sectorDecile: partial.sectorDecile ?? 7,
    cheapness: partial.cheapness ?? 0.5,
    z: partial.z ?? {
      grossMarginInflection: 0.5,
      ebitdaMarginInflection: 0.25,
      revenueGrowthAccel: null,
      fcfInflection: 1,
      roicTrend: -0.5,
      deleveraging: 0,
    },
  };
}

describe("buildDiscoverySummary", () => {
  it("groups by sector then subsector with correct name counts", () => {
    const rows = [
      row({ sector: "ENERGY", subsector: "Oil", composite: 2 }),
      row({ sector: "ENERGY", subsector: "Oil", composite: 4 }),
      row({ sector: "ENERGY", subsector: "Gas", composite: 1 }),
      row({ sector: "TECH", subsector: "Software", composite: 3 }),
    ];
    const summary = buildDiscoverySummary(rows);
    expect(summary).toHaveLength(2);
    const energy = summary.find((s) => s.key === "ENERGY")!;
    expect(energy.nameCount).toBe(3);
    expect(energy.subsectors).toHaveLength(2);
    const oil = energy.subsectors.find((s) => s.key === "Oil")!;
    expect(oil.nameCount).toBe(2);
    expect(oil.avgComposite).toBeCloseTo(3, 6);
  });

  it("averages signal z-scores ignoring nulls", () => {
    const rows = [
      row({ z: { grossMarginInflection: 1, ebitdaMarginInflection: null, revenueGrowthAccel: null, fcfInflection: null, roicTrend: null, deleveraging: null } }),
      row({ z: { grossMarginInflection: 3, ebitdaMarginInflection: null, revenueGrowthAccel: null, fcfInflection: null, roicTrend: null, deleveraging: null } }),
    ];
    const [tech] = buildDiscoverySummary(rows);
    expect(tech.avgSignals.grossMarginInflection).toBeCloseTo(2, 6);
    expect(tech.avgSignals.ebitdaMarginInflection).toBeNull();
  });

  it("sorts sectors by avg composite descending", () => {
    const rows = [
      row({ sector: "LOW", composite: 0.5 }),
      row({ sector: "HIGH", composite: 5 }),
    ];
    const summary = buildDiscoverySummary(rows);
    expect(summary[0]!.key).toBe("HIGH");
    expect(summary[1]!.key).toBe("LOW");
  });

  it("falls back to Unclassified for blank sector", () => {
    const summary = buildDiscoverySummary([
      row({ sector: null, subsector: null }),
    ]);
    expect(summary[0]!.key).toBe("Unclassified");
  });
});
