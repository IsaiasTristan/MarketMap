import { describe, expect, it } from "vitest";
import { fmtUsdCompact, fmtFlowDollars, fmtMoney } from "@/components/analysis/flows/flowsUi";

describe("fmtUsdCompact — carries at unit boundaries (never $1000k / $1000M)", () => {
  it("keeps thousands below $999.5k", () => {
    expect(fmtUsdCompact(999_000)).toBe("$999k");
    expect(fmtUsdCompact(50_000)).toBe("$50k");
  });
  it("carries k → M at the boundary", () => {
    expect(fmtUsdCompact(999_600)).toBe("$1.0M"); // NOT $1000k
    expect(fmtUsdCompact(1_000_000)).toBe("$1.0M");
  });
  it("shows one decimal for millions under $100M, none at/above", () => {
    expect(fmtUsdCompact(1_500_000)).toBe("$1.5M");
    expect(fmtUsdCompact(282_000_000)).toBe("$282M");
    expect(fmtUsdCompact(999_000_000)).toBe("$999M");
  });
  it("carries M → B at the boundary", () => {
    expect(fmtUsdCompact(999_600_000)).toBe("$1.0B"); // NOT $1000M
    expect(fmtUsdCompact(1_000_000_000)).toBe("$1.0B");
    expect(fmtUsdCompact(4_400_000_000)).toBe("$4.4B");
  });
});

describe("fmtFlowDollars — signed, uses the shared formatter", () => {
  it("signs and never emits k above $999k", () => {
    expect(fmtFlowDollars(999_600)).toBe("+$1.0M");
    expect(fmtFlowDollars(-4_400_000_000)).toBe("−$4.4B");
    expect(fmtFlowDollars(-282_000_000)).toBe("−$282M");
    expect(fmtFlowDollars(0)).toBe("+$0");
  });
  it("returns — for null/undefined", () => {
    expect(fmtFlowDollars(null)).toBe("—");
    expect(fmtFlowDollars(undefined)).toBe("—");
  });
});

describe("fmtMoney — millions in, compact out (same contract)", () => {
  it("matches fmtUsdCompact scaled by 1e6", () => {
    expect(fmtMoney(282)).toBe("$282M");
    expect(fmtMoney(4_400)).toBe("$4.4B");
    expect(fmtMoney(1)).toBe("$1.0M");
    expect(fmtMoney(999.6)).toBe("$1.0B"); // 999.6M carries to 1.0B
  });
});
