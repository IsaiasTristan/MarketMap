/**
 * Factor coverage check.
 *
 * Given a desired regression window and a per-factor return series, returns
 * the subset of factors with enough continuous history for the window, plus
 * a status report for the dropped ones. Used by both the portfolio engine
 * and the per-stock service so the UI can badge "insufficient history".
 *
 * Pure function — no DB or HTTP I/O.
 */
import type { FactorCode, FactorCoverage } from "@/types/factors";

export interface CoverageInput {
  /** All requested factors. */
  factorCodes: FactorCode[];
  /** Aligned date series (ascending) shared across all factors. */
  dates: string[];
  /** Per-factor map of date → value. Missing dates count as missing data. */
  perFactorByDate: Map<FactorCode, Map<string, number>>;
  /** Regression window in trading days (the *target* lookback). */
  window: number;
  /**
   * Minimum required observations within the window for a factor to be
   * counted as having "OK" coverage. Defaults to ceil(0.95 × window) so a
   * factor missing a handful of trading days still passes.
   */
  minObsRatio?: number;
}

export interface CoverageResult {
  /** Factors that have enough data to participate in the regression. */
  usableFactors: FactorCode[];
  /** Per-factor status for the entire requested set. */
  coverage: FactorCoverage[];
  /**
   * Aligned dates in the window that all `usableFactors` cover continuously.
   * This is the date set the regression should run on.
   */
  alignedWindowDates: string[];
}

/**
 * Compute factor coverage for a regression window.
 *
 * Algorithm:
 *  1. Take the last `window` dates from `dates` as the candidate window.
 *  2. For each factor, count how many of those dates have a value.
 *  3. A factor is OK iff it covers at least `minObsRatio × window` of them
 *     AND its first observation is on or before the window start.
 *  4. The aligned-window date set is the intersection of dates covered by
 *     every usable factor (so OLS sees a clean rectangle).
 */
export function computeFactorCoverage(input: CoverageInput): CoverageResult {
  const { factorCodes, dates, perFactorByDate, window } = input;
  const minObsRatio = input.minObsRatio ?? 0.95;

  const sortedDates = [...dates].sort();
  const windowDates = sortedDates.slice(-window);
  const requiredObs = Math.ceil(window * minObsRatio);

  const coverage: FactorCoverage[] = [];
  const usableFactors: FactorCode[] = [];

  for (const code of factorCodes) {
    const factorMap = perFactorByDate.get(code);
    if (!factorMap || factorMap.size === 0) {
      coverage.push({
        code,
        status: "MISSING_DATA",
        inceptionDate: null,
        observationsAvailable: 0,
      });
      continue;
    }

    const inceptionDate = [...factorMap.keys()].sort()[0] ?? null;
    let obs = 0;
    for (const d of windowDates) if (factorMap.has(d)) obs++;

    const insufficientHistory =
      inceptionDate !== null &&
      windowDates.length > 0 &&
      inceptionDate > windowDates[0]!;

    if (obs >= requiredObs && !insufficientHistory) {
      usableFactors.push(code);
      coverage.push({
        code,
        status: "OK",
        inceptionDate,
        observationsAvailable: obs,
      });
    } else {
      coverage.push({
        code,
        status: insufficientHistory ? "INSUFFICIENT_HISTORY" : "MISSING_DATA",
        inceptionDate,
        observationsAvailable: obs,
      });
    }
  }

  // Aligned dates = window dates where every usable factor has a value
  const alignedWindowDates = windowDates.filter((d) =>
    usableFactors.every((c) => perFactorByDate.get(c)?.has(d)),
  );

  return { usableFactors, coverage, alignedWindowDates };
}
