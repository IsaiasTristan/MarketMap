/**
 * Window-scoped coverage diagnostics for the Risk tab.
 *
 * Reports which holdings have no / partial / full price observations within
 * the selected trailing risk window (1M / 6M / 1Y / 2Y / 5Y). The shape
 * matches `PortfolioCoverageDiagnostics` so the existing `CoverageWarning`
 * chip renders short-history + excluded lists out of the box.
 *
 * Pure helper (no DB / I/O) — `factor-engine.service.ts` slices the engine's
 * aligned window and calls in here.
 */
import type { PortfolioCoverageDiagnostics } from "@/types/factors";

export interface WindowCoveragePositionInput {
  ticker: string;
  /** date (YYYY-MM-DD) -> adjClose for this position. */
  priceByDate: Map<string, number>;
  /** Earliest available price date for this position (across all history). */
  firstDate: string | null;
  /** Latest available price date for this position (across all history). */
  lastDate: string | null;
}

/**
 * Build window-scoped coverage diagnostics.
 *
 * For each holding, count price observations that fall inside `windowDates`:
 *   - 0           -> excludedPositions (with a `reason` embedding its real
 *                    data range so the user can see why it's missing).
 *   - 0 < n < W   -> shortHistoryPositions (firstDate + observation count).
 *   - n == W      -> clean, no entry in either list.
 *
 * @param windowDates Sorted ascending list of trading dates in the trailing
 *                    window (e.g. last 252 aligned days for the 1Y preset).
 * @param positions   Per-position price maps + first/last real data date.
 */
export function buildWindowCoverageDiagnostics(
  windowDates: string[],
  positions: WindowCoveragePositionInput[],
): PortfolioCoverageDiagnostics {
  const windowLen = windowDates.length;
  const seriesStart = windowDates[0] ?? null;
  const seriesEnd = windowDates[windowLen - 1] ?? null;

  const shortHistoryPositions: PortfolioCoverageDiagnostics["shortHistoryPositions"] = [];
  const excludedPositions: PortfolioCoverageDiagnostics["excludedPositions"] = [];

  for (const p of positions) {
    let count = 0;
    let firstInWindow: string | null = null;
    for (const d of windowDates) {
      if (p.priceByDate.has(d)) {
        count++;
        if (firstInWindow === null) firstInWindow = d;
      }
    }

    if (count === 0) {
      const range =
        p.firstDate && p.lastDate
          ? `data ${p.firstDate} → ${p.lastDate}`
          : "no price history";
      const windowSpan =
        seriesStart && seriesEnd ? `${seriesStart} → ${seriesEnd}` : "selected window";
      excludedPositions.push({
        ticker: p.ticker,
        reason: `${range}, none in window (${windowSpan})`,
      });
      continue;
    }

    if (count < windowLen) {
      shortHistoryPositions.push({
        ticker: p.ticker,
        firstDate: firstInWindow ?? p.firstDate ?? seriesStart ?? "",
        observations: count,
      });
    }
  }

  return {
    totalPositions: positions.length,
    seriesStart,
    seriesEnd,
    alignedDates: windowLen,
    shortHistoryPositions,
    excludedPositions,
    droppedLowCoverageDates: 0,
  };
}
