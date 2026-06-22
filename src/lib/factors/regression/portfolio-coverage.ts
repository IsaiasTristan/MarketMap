/**
 * Coverage-weighted portfolio return construction.
 *
 * The factor engine builds a portfolio's daily return series from the UNION of
 * its positions' price dates rather than the inner-join intersection. On each
 * date we include only the holdings that actually traded (valid prev + cur
 * prices) and renormalize the present signed weights to full investment. A
 * recently-listed holding (IPO / short history) therefore contributes only
 * once it has prices, instead of truncating the whole portfolio's aligned
 * window down to its own short history.
 *
 * This module is the pure part of that logic (no DB / I/O) so it can be tested
 * directly; `factor-engine.service.ts` loads the prices and calls in here.
 */
import type { PortfolioCoverageDiagnostics } from "@/types/factors";

export interface CoveragePositionInput {
  ticker: string;
  /** date (YYYY-MM-DD) -> adjClose for this position. */
  priceByDate: Map<string, number>;
  /** Earliest available price date for this position, or null if none. */
  firstDate: string | null;
  /** Signed gross-normalized weight (long +, short −). */
  weight: number;
  /** Absolute gross market value of the position. */
  gross: number;
}

export interface CoverageWeightedReturns {
  dates: string[];
  returns: number[];
  coverage: PortfolioCoverageDiagnostics;
}

/**
 * Build the coverage-weighted daily return series + coverage diagnostics.
 *
 * @param allDates    Sorted union of every position's price dates.
 * @param positions   Per-position price maps + signed weights + gross value.
 * @param minCoverage Minimum present-gross fraction for a date to be kept.
 */
export function buildCoverageWeightedReturns(
  allDates: string[],
  positions: CoveragePositionInput[],
  minCoverage: number,
): CoverageWeightedReturns {
  const totalGross = positions.reduce((s, p) => s + p.gross, 0);
  const dates: string[] = [];
  const returns: number[] = [];
  const contribCount = positions.map(() => 0);
  let droppedLowCoverageDates = 0;

  for (let i = 1; i < allDates.length; i++) {
    const dPrev = allDates[i - 1]!;
    const dCur = allDates[i]!;
    let presentGross = 0;
    let r = 0;
    const presentThisDate: number[] = [];
    for (let j = 0; j < positions.length; j++) {
      const prev = positions[j]!.priceByDate.get(dPrev);
      const cur = positions[j]!.priceByDate.get(dCur);
      if (prev != null && cur != null && prev > 0) {
        presentGross += positions[j]!.gross;
        r += positions[j]!.weight * ((cur - prev) / prev);
        presentThisDate.push(j);
      }
    }
    const coverageWeight = totalGross > 0 ? presentGross / totalGross : 0;
    if (coverageWeight < minCoverage) {
      droppedLowCoverageDates++;
      continue;
    }
    dates.push(dCur);
    returns.push(r / coverageWeight);
    for (const j of presentThisDate) contribCount[j]!++;
  }

  const seriesStart = dates[0] ?? null;
  const seriesEnd = dates[dates.length - 1] ?? null;
  const shortHistoryPositions: PortfolioCoverageDiagnostics["shortHistoryPositions"] = [];
  const excludedPositions: PortfolioCoverageDiagnostics["excludedPositions"] = [];

  for (let j = 0; j < positions.length; j++) {
    const ticker = positions[j]!.ticker;
    if (contribCount[j] === 0) {
      excludedPositions.push({ ticker, reason: "No overlapping price history" });
      continue;
    }
    if (contribCount[j]! < dates.length) {
      shortHistoryPositions.push({
        ticker,
        firstDate: positions[j]!.firstDate ?? seriesStart ?? "",
        observations: contribCount[j]!,
      });
    }
  }

  return {
    dates,
    returns,
    coverage: {
      totalPositions: positions.length,
      seriesStart,
      seriesEnd,
      alignedDates: dates.length,
      shortHistoryPositions,
      excludedPositions,
      droppedLowCoverageDates,
    },
  };
}
