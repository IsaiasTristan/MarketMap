/**
 * Unit tests for the factor freshness diagnostic
 * (`src/lib/factors/diagnostics/freshness.ts`). Pure function, no I/O.
 *
 * Scope:
 *   • Threshold semantics (lag <= threshold ⇒ no flag, lag > threshold ⇒ flag).
 *   • Weekend skipping in the trading-day counter.
 *   • Empty-input edge cases.
 *   • Multi-factor sorting (lag desc, then factor code asc).
 *   • RF folded into reference-date computation and reported separately.
 *   • Factors missing entirely from the matrix do not produce entries.
 */
import { describe, expect, it } from "vitest";
import {
  detectFactorStaleness,
  tradingDayDiff,
} from "../../src/lib/factors/diagnostics/freshness";
import type { FactorCode } from "../../src/types/factors";

function mkMatrix(rows: Array<{ date: string; values: Partial<Record<FactorCode, number>> }>) {
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    out.set(
      r.date,
      Object.fromEntries(
        Object.entries(r.values).filter(([, v]) => v != null),
      ) as Record<string, number>,
    );
  }
  return out;
}

describe("tradingDayDiff", () => {
  it("returns 0 when from >= to", () => {
    expect(tradingDayDiff("2026-04-24", "2026-04-24")).toBe(0);
    expect(tradingDayDiff("2026-04-24", "2026-04-23")).toBe(0);
  });

  it("counts only weekdays between dates (exclusive of from, inclusive of to)", () => {
    // 2026-04-24 = Friday, 2026-04-27 = Monday.
    // Diff = Saturday (skip), Sunday (skip), Monday (count) -> 1.
    expect(tradingDayDiff("2026-04-24", "2026-04-27")).toBe(1);
  });

  it("counts a 5-business-day span correctly", () => {
    // 2026-04-20 (Mon) -> 2026-04-27 (Mon): Tue, Wed, Thu, Fri, Mon -> 5
    expect(tradingDayDiff("2026-04-20", "2026-04-27")).toBe(5);
  });

  it("matches the ~40-trading-day KF lag empirically", () => {
    // KF last published 2026-02-27 (Fri); reference 2026-04-24 (Fri).
    // 8 weeks of weekdays = 40 trading days.
    expect(tradingDayDiff("2026-02-27", "2026-04-24")).toBe(40);
  });
});

describe("detectFactorStaleness", () => {
  it("returns empty when all factors share the latest date", () => {
    const m = mkMatrix([
      { date: "2026-04-22", values: { EQ: 0.01, HML: 0.002, MOM: 0.003 } },
      { date: "2026-04-23", values: { EQ: 0.015, HML: 0.001, MOM: 0.002 } },
      { date: "2026-04-24", values: { EQ: 0.02, HML: 0.003, MOM: 0.001 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML", "MOM"]);
    expect(out).toEqual([]);
  });

  it("returns empty when factorByDate is empty", () => {
    expect(detectFactorStaleness(new Map(), ["EQ"])).toEqual([]);
  });

  it("returns empty when usableFactors is empty", () => {
    const m = mkMatrix([{ date: "2026-04-24", values: { EQ: 0.01 } }]);
    expect(detectFactorStaleness(m, [])).toEqual([]);
  });

  it("flags a factor whose last date trails reference by > threshold", () => {
    // EQ fresh through Apr 24, HML last on Feb 27 (40 trading days behind).
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-03-02", values: { EQ: 0.02 } },
      { date: "2026-04-24", values: { EQ: 0.015 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      factor: "HML",
      lastDate: "2026-02-27",
      referenceDate: "2026-04-24",
      lagTradingDays: 40,
    });
  });

  it("does not flag a factor at exactly the threshold", () => {
    // HML 3 trading days behind (default threshold = 3) -> NOT flagged.
    // 2026-04-21 Tue -> 2026-04-24 Fri = Wed, Thu, Fri = 3
    const m = mkMatrix([
      { date: "2026-04-21", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-04-22", values: { EQ: 0.01 } },
      { date: "2026-04-23", values: { EQ: 0.01 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"]);
    expect(out).toEqual([]);
  });

  it("flags at threshold + 1", () => {
    // HML 4 trading days behind (lag > 3) -> flagged.
    // 2026-04-20 Mon -> 2026-04-24 Fri = Tue, Wed, Thu, Fri = 4
    const m = mkMatrix([
      { date: "2026-04-20", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-04-21", values: { EQ: 0.01 } },
      { date: "2026-04-22", values: { EQ: 0.01 } },
      { date: "2026-04-23", values: { EQ: 0.01 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.factor).toBe("HML");
    expect(out[0]!.lagTradingDays).toBe(4);
  });

  it("respects a custom threshold", () => {
    const m = mkMatrix([
      { date: "2026-04-20", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-04-21", values: { EQ: 0.01 } },
      { date: "2026-04-22", values: { EQ: 0.01 } },
      { date: "2026-04-23", values: { EQ: 0.01 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    expect(detectFactorStaleness(m, ["EQ", "HML"], { thresholdTradingDays: 4 })).toEqual([]);
    const looser = detectFactorStaleness(m, ["EQ", "HML"], { thresholdTradingDays: 0 });
    expect(looser).toHaveLength(1);
    expect(looser[0]!.factor).toBe("HML");
  });

  it("treats null and NaN as 'no row' for that date", () => {
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-04-24", values: { EQ: 0.01, HML: NaN } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.factor).toBe("HML");
    expect(out[0]!.lastDate).toBe("2026-02-27");
  });

  it("orders multi-factor results by lag desc, then factor asc", () => {
    // Reference Apr 24. HML last Feb 27 (40d). MOM last Mar 27 (~20d).
    // BAB last Apr 17 (5 trading days). All three should flag at threshold=3.
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002, MOM: 0.003, BAB: 0.001 } },
      { date: "2026-03-27", values: { EQ: 0.01, MOM: 0.003, BAB: 0.001 } },
      { date: "2026-04-17", values: { EQ: 0.01, BAB: 0.001 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML", "MOM", "BAB"]);
    expect(out.map((s) => s.factor)).toEqual(["HML", "MOM", "BAB"]);
    expect(out[0]!.lagTradingDays).toBeGreaterThan(out[1]!.lagTradingDays);
    expect(out[1]!.lagTradingDays).toBeGreaterThan(out[2]!.lagTradingDays);
  });

  it("ties: same lag sorts by factor code ascending", () => {
    // Both HML and MOM stale by 40 trading days.
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002, MOM: 0.003 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "MOM", "HML"]);
    expect(out.map((s) => s.factor)).toEqual(["HML", "MOM"]);
  });

  it("does not produce an entry for a factor missing from the matrix entirely", () => {
    const m = mkMatrix([
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"]);
    expect(out).toEqual([]);
  });

  it("folds RF into reference-date and flags RF when stale", () => {
    // Mirrors the actual prod state on 2026-04-26: every MACRO14 factor fresh
    // through Apr 24 except RF, which is at Feb 27 (40 trading days behind).
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-04-24", values: { EQ: 0.01, HML: 0.001 } },
    ]);
    const rf = new Map<string, number>([
      ["2026-02-27", 0.00018],
      ["2026-02-26", 0.00018],
    ]);
    const out = detectFactorStaleness(m, ["EQ", "HML"], { rfByDate: rf });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      factor: "RF",
      lastDate: "2026-02-27",
      referenceDate: "2026-04-24",
      lagTradingDays: 40,
    });
  });

  it("RF + factor staleness coexist and sort together", () => {
    const m = mkMatrix([
      { date: "2026-02-27", values: { EQ: 0.01, HML: 0.002 } },
      { date: "2026-03-27", values: { EQ: 0.01 } },
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const rf = new Map<string, number>([["2026-04-10", 0.00018]]);
    // HML lag = 40, RF lag = 10 (Apr 13 - Apr 24 = 9 trading days, so 10).
    const out = detectFactorStaleness(m, ["EQ", "HML"], { rfByDate: rf });
    expect(out.map((s) => s.factor)).toEqual(["HML", "RF"]);
    expect(out[0]!.lagTradingDays).toBeGreaterThan(out[1]!.lagTradingDays);
  });

  it("does not flag RF when it is the latest series in the matrix", () => {
    const m = mkMatrix([
      { date: "2026-04-24", values: { EQ: 0.01 } },
    ]);
    const rf = new Map<string, number>([["2026-04-24", 0.00018]]);
    const out = detectFactorStaleness(m, ["EQ"], { rfByDate: rf });
    expect(out).toEqual([]);
  });
});
