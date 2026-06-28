import { describe, expect, it } from "vitest";
import {
  accrualsDivergence,
  accrualsRatio,
  compounder,
  trapFlag,
} from "@/lib/fundamental/quality";

describe("accrualsRatio", () => {
  it("is positive when net income exceeds operating cash flow (low quality)", () => {
    expect(accrualsRatio(100, 60, 1000)!).toBeCloseTo(0.04, 9);
  });
  it("returns null on missing OCF (degrade, never zero-fill)", () => {
    expect(accrualsRatio(100, null, 1000)).toBeNull();
  });
  it("returns null on a degenerate asset base", () => {
    expect(accrualsRatio(1, 0, 0)).toBeNull();
  });
});

describe("accrualsDivergence", () => {
  it("is positive when NI growth outruns CFO growth", () => {
    const ni = [10, 12, 15, 19, 24];
    const cfo = [10, 10, 10, 10, 10];
    expect(accrualsDivergence(ni, cfo)!).toBeGreaterThan(0);
  });
  it("returns null with insufficient history", () => {
    expect(accrualsDivergence([1], [1])).toBeNull();
  });
});

describe("trapFlag", () => {
  it("raises on a high accruals ratio", () => {
    expect(trapFlag({ accrualsRatio: 0.2, accrualsDivergence: null })).toBe(true);
  });
  it("raises on clear NI-vs-cash divergence", () => {
    expect(trapFlag({ accrualsRatio: null, accrualsDivergence: 0.3 })).toBe(true);
  });
  it("does not raise on clean inputs or nulls", () => {
    expect(trapFlag({ accrualsRatio: 0.01, accrualsDivergence: 0.0 })).toBe(false);
    expect(trapFlag({ accrualsRatio: null, accrualsDivergence: null })).toBe(false);
  });
});

describe("compounder", () => {
  it("scores high+stable ROIC above high+volatile ROIC", () => {
    const stable = compounder([0.2, 0.21, 0.2, 0.22, 0.2, 0.21]);
    const volatile = compounder([0.05, 0.4, 0.02, 0.5, 0.0, 0.45]);
    expect(stable.score!).toBeGreaterThan(volatile.score!);
    expect(stable.consistency!).toBeGreaterThan(volatile.consistency!);
  });
  it("returns nulls with < 4 finite points", () => {
    expect(compounder([0.2, 0.2]).score).toBeNull();
  });
});
