/**
 * Tests for the Risk-tab window-scoped coverage helper.
 *
 * Pins the contract: a holding with NO price observations inside the
 * selected trailing window lands in `excludedPositions` (with a reason
 * naming its real data range); a partial-history holding lands in
 * `shortHistoryPositions`; a fully-present holding ends up in neither
 * list. The window span itself drives `seriesStart` / `seriesEnd` /
 * `alignedDates` so the existing CoverageWarning chip can render its
 * tooltip footer correctly.
 */
import { describe, it, expect } from "vitest";
import {
  buildWindowCoverageDiagnostics,
  type WindowCoveragePositionInput,
} from "../../src/lib/factors/regression/window-coverage";

function makeDates(n: number, offset = 0): string[] {
  const base = new Date("2024-01-01");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + offset + i);
    return d.toISOString().slice(0, 10);
  });
}

function priceMap(dates: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) m.set(dates[i]!, 100 + i);
  return m;
}

describe("buildWindowCoverageDiagnostics (risk-window coverage)", () => {
  it("flags zero-data-in-window as excluded with a data-range reason", () => {
    // 5Y window equivalent: 252 days of recent history.
    const windowDates = makeDates(252, 1000);
    // IPO with only the FIRST 50 days of history — well outside the window.
    const ipoDates = makeDates(50, 0);
    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "IPO",
        priceByDate: priceMap(ipoDates),
        firstDate: ipoDates[0]!,
        lastDate: ipoDates[ipoDates.length - 1]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics(windowDates, positions);

    expect(diag.excludedPositions).toHaveLength(1);
    expect(diag.excludedPositions[0]!.ticker).toBe("IPO");
    // Reason must embed the holding's REAL data range so the user can see
    // why it's missing (e.g. "data 2024-01-01 → 2024-02-19, none in window").
    expect(diag.excludedPositions[0]!.reason).toContain(ipoDates[0]!);
    expect(diag.excludedPositions[0]!.reason).toContain(ipoDates[ipoDates.length - 1]!);
    expect(diag.excludedPositions[0]!.reason).toContain(windowDates[0]!);
    expect(diag.excludedPositions[0]!.reason).toContain(windowDates[251]!);
    expect(diag.shortHistoryPositions).toHaveLength(0);
  });

  it("flags partial-history holdings as short history with correct count", () => {
    const windowDates = makeDates(252, 1000);
    // Recent IPO whose history starts halfway through the window — present
    // on the last 50 days of the 252-day window.
    const ipoDates = windowDates.slice(-50);
    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "RECENT",
        priceByDate: priceMap(ipoDates),
        firstDate: ipoDates[0]!,
        lastDate: ipoDates[ipoDates.length - 1]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics(windowDates, positions);

    expect(diag.shortHistoryPositions).toHaveLength(1);
    expect(diag.shortHistoryPositions[0]!.ticker).toBe("RECENT");
    expect(diag.shortHistoryPositions[0]!.observations).toBe(50);
    expect(diag.shortHistoryPositions[0]!.firstDate).toBe(ipoDates[0]!);
    expect(diag.excludedPositions).toHaveLength(0);
  });

  it("leaves fully-covered holdings out of both lists", () => {
    const windowDates = makeDates(252, 1000);
    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "OLD",
        priceByDate: priceMap(windowDates),
        firstDate: windowDates[0]!,
        lastDate: windowDates[windowDates.length - 1]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics(windowDates, positions);

    expect(diag.shortHistoryPositions).toHaveLength(0);
    expect(diag.excludedPositions).toHaveLength(0);
    expect(diag.totalPositions).toBe(1);
  });

  it("seriesStart/seriesEnd/alignedDates span the supplied window", () => {
    const windowDates = makeDates(126, 500); // 6M preset
    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "ANY",
        priceByDate: priceMap(windowDates),
        firstDate: windowDates[0]!,
        lastDate: windowDates[windowDates.length - 1]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics(windowDates, positions);

    expect(diag.seriesStart).toBe(windowDates[0]!);
    expect(diag.seriesEnd).toBe(windowDates[windowDates.length - 1]!);
    expect(diag.alignedDates).toBe(126);
    // Risk window coverage doesn't drop low-coverage dates (the engine has
    // already done that upstream), so this counter is always zero here.
    expect(diag.droppedLowCoverageDates).toBe(0);
  });

  it("classifies a mixed portfolio correctly across one window slice", () => {
    const windowDates = makeDates(252, 1000);
    // Three holdings: full, partial (last 30 days), zero-in-window (all
    // history precedes the window).
    const fullPriceMap = priceMap(windowDates);
    const partialDates = windowDates.slice(-30);
    const oldOnlyDates = makeDates(20, 0);

    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "FULL",
        priceByDate: fullPriceMap,
        firstDate: windowDates[0]!,
        lastDate: windowDates[windowDates.length - 1]!,
      },
      {
        ticker: "PARTIAL",
        priceByDate: priceMap(partialDates),
        firstDate: partialDates[0]!,
        lastDate: partialDates[partialDates.length - 1]!,
      },
      {
        ticker: "ZERO",
        priceByDate: priceMap(oldOnlyDates),
        firstDate: oldOnlyDates[0]!,
        lastDate: oldOnlyDates[oldOnlyDates.length - 1]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics(windowDates, positions);

    expect(diag.totalPositions).toBe(3);
    expect(diag.shortHistoryPositions.map((p) => p.ticker)).toEqual(["PARTIAL"]);
    expect(diag.shortHistoryPositions[0]!.observations).toBe(30);
    expect(diag.excludedPositions.map((p) => p.ticker)).toEqual(["ZERO"]);
  });

  it("handles an empty window: every holding lands in excluded", () => {
    // The engine is upstream of this helper and returns null before we'd be
    // called with an empty window in practice; this test pins behaviour so
    // a degenerate caller never produces a misleading "all clean" reading.
    const oldDates = makeDates(10);
    const positions: WindowCoveragePositionInput[] = [
      {
        ticker: "OLD",
        priceByDate: priceMap(oldDates),
        firstDate: oldDates[0]!,
        lastDate: oldDates[9]!,
      },
    ];

    const diag = buildWindowCoverageDiagnostics([], positions);

    expect(diag.alignedDates).toBe(0);
    expect(diag.seriesStart).toBeNull();
    expect(diag.seriesEnd).toBeNull();
    expect(diag.totalPositions).toBe(1);
    expect(diag.excludedPositions).toHaveLength(1);
    expect(diag.excludedPositions[0]!.ticker).toBe("OLD");
  });
});
