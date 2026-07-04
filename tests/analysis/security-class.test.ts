import { describe, expect, it } from "vitest";
import { classifySecurity, UNCLASSIFIED_SECTOR } from "@/lib/institutional/security-class";
import {
  computeActiveFlowPair,
  type FundHoldingsByPeriod,
  type SectorMeta,
} from "@/server/services/institutional/institutional-active-flow.service";

describe("classifySecurity", () => {
  it("flags the Index & Macro sector as a vehicle (excluded from sectors)", () => {
    const c = classifySecurity("Index & Macro", "US Sector ETFs");
    expect(c.securityClass).toBe("vehicle");
    expect(c.groupSector).toBeNull();
  });
  it("flags a Levered ETFs sub-theme as a vehicle even inside an equity sector", () => {
    const c = classifySecurity("Crypto/Speculative", "Levered ETFs");
    expect(c.securityClass).toBe("vehicle");
    expect(c.groupSector).toBeNull();
  });
  it("keeps Crypto/Speculative equities (Miners) as their canonical sector", () => {
    const c = classifySecurity("Crypto/Speculative", "Miners");
    expect(c.securityClass).toBe("equity");
    expect(c.groupSector).toBe("Crypto/Speculative");
  });
  it("keeps Mega Cap / International Mega equities as canonical rows", () => {
    expect(classifySecurity("Mega Cap", "Platforms").groupSector).toBe("Mega Cap");
    expect(classifySecurity("International Mega", "China").groupSector).toBe("International Mega");
  });
  it("folds the legacy 'Financial Services' string into canonical 'Financials'", () => {
    const c = classifySecurity("Financial Services", null);
    expect(c.securityClass).toBe("equity");
    expect(c.groupSector).toBe("Financials");
  });
  it("buckets a name with no canonical sector as Unclassified (never dropped)", () => {
    const c = classifySecurity(null, null);
    expect(c.securityClass).toBe("unclassified");
    expect(c.groupSector).toBe(UNCLASSIFIED_SECTOR);
  });
});

// ── fixture helpers ──────────────────────────────────────────────────────────
function holdings(spec: Record<string, Record<string, [number, number]>>): FundHoldingsByPeriod {
  const m: FundHoldingsByPeriod = new Map();
  for (const [fund, hs] of Object.entries(spec)) {
    const inner = new Map<string, { shares: number; value: number }>();
    for (const [t, [shares, value]] of Object.entries(hs)) inner.set(t, { shares, value });
    m.set(fund, inner);
  }
  return m;
}
/** Build the SectorMeta the way the aggregation service does — via classifySecurity. */
function classifiedMeta(raw: Record<string, [string | null, string | null]>): SectorMeta {
  const m = new Map<string, { sector: string | null; subsector: string | null }>();
  for (const [t, [sector, subTheme]] of Object.entries(raw)) {
    const c = classifySecurity(sector, subTheme);
    m.set(t, { sector: c.groupSector, subsector: c.groupSubsector });
  }
  return m;
}

describe("rotation partition completeness (Part 2)", () => {
  it("sector net-$ sums to the net-$ of classified names; vehicles excluded", () => {
    // Flat prices at 10. Two funds trade across equities, a vehicle, and an
    // uncovered micro-cap. Financial Services must fold into Financials.
    const prev = holdings({
      F1: { NVDA: [100, 1000], JPM: [100, 1000], BRK: [100, 1000], SPY: [100, 1000], MICRO: [100, 1000] },
      F2: { NVDA: [50, 500], JPM: [200, 2000], LEVR: [100, 1000] },
    });
    const cur = holdings({
      F1: { NVDA: [140, 1400], JPM: [60, 600], BRK: [120, 1200], SPY: [100, 1000], MICRO: [130, 1300] },
      F2: { NVDA: [80, 800], JPM: [170, 1700], LEVR: [40, 400] },
    });
    const meta = classifiedMeta({
      NVDA: ["Semis & AI", "AI/Compute"],
      JPM: ["Financials", "Banks"],
      BRK: ["Financial Services", "Insurance"], // legacy alias → Financials
      SPY: ["Index & Macro", "US Equity Index"], // vehicle
      LEVR: ["Crypto/Speculative", "Levered ETFs"], // vehicle
      MICRO: [null, null], // uncovered → Unclassified
    });
    const { byName, byGroup } = computeActiveFlowPair(prev, cur, meta);

    // Vehicles never form a sector bucket.
    for (const key of byGroup.keys()) {
      expect(key).not.toContain("Index & Macro");
      expect(key).not.toContain("Crypto/Speculative");
    }
    // BRK folded into Financials (no separate Financial Services bucket).
    expect(byGroup.has("SECTOR|Financials")).toBe(true);
    expect(byGroup.has("SECTOR|Financial Services")).toBe(false);
    // Uncovered name is bucketed, not dropped.
    expect(byGroup.has(`SECTOR|${UNCLASSIFIED_SECTOR}`)).toBe(true);

    // Partition: Σ sector dollars == Σ dollars of non-vehicle names.
    let sectorSum = 0;
    for (const [key, stat] of byGroup) if (key.startsWith("SECTOR|")) sectorSum += stat.dollarNetFlow;
    const NON_VEHICLE = ["NVDA", "JPM", "BRK", "MICRO"];
    let nameSum = 0;
    for (const t of NON_VEHICLE) nameSum += byName.get(t)!.dollarNetFlow;
    expect(sectorSum).toBeCloseTo(nameSum, 2);

    // And the vehicles carried real name-level dollars that are correctly omitted.
    expect(byName.get("SPY")!.dollarNetFlow).toBeCloseTo(0, 2); // held flat
    expect(byName.get("LEVR")!.dollarNetFlow).toBeLessThan(0); // trimmed
  });
});
