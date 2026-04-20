/**
 * Per-security factor loading estimation.
 *
 * For each open position, runs a multivariate OLS regression of the
 * security's daily excess returns against the chosen factor set over a
 * configurable lookback window. This gives security-level factor betas
 * that can be aggregated by weight to explain portfolio factor exposure
 * from a holdings perspective.
 *
 * This is the "holdings-implied" view complementing the returns-based
 * regression on the portfolio return series.
 */
import type { FactorCode, PositionLoadings } from "@/types/factors";
import { multivariateOls } from "../regression/ols";
import { exponentialWeights } from "../regression/weights";

export interface SecurityReturnSeries {
  ticker: string;
  sector: string;
  subTheme: string;
  weight: number;
  /** Daily total returns, aligned to the shared date set. */
  dates: string[];
  returns: number[];
}

/**
 * Compute per-security factor loadings.
 *
 * @param securities      Position return series (all aligned to same dates).
 * @param factorCodes     Factor codes in regression order.
 * @param factorMatrix    Factor return matrix; index = date position, inner = factor values.
 * @param rfSeries        Daily RF series aligned to dates.
 * @param window          Lookback window in trading days.
 * @param ewHalfLife      Optional EW half-life.
 */
export function computeHoldingsLoadings(
  securities: SecurityReturnSeries[],
  factorCodes: FactorCode[],
  factorMatrix: number[][],  // n × k aligned to shared dates
  rfSeries: number[],
  window: number,
  ewHalfLife?: number | null,
): PositionLoadings[] {
  const n = factorMatrix.length;
  const useWindow = Math.min(window, n);
  const start = Math.max(0, n - useWindow);

  const xSlice = factorMatrix.slice(start);
  const rfSlice = rfSeries.slice(start);
  const weights = exponentialWeights(xSlice.length, ewHalfLife);

  return securities.map((sec) => {
    const ySlice = sec.returns.slice(start).map((r, i) => r - (rfSlice[i] ?? 0));
    if (ySlice.length < factorCodes.length + 2) {
      const loadings: Partial<Record<FactorCode, number>> = {};
      for (const code of factorCodes) loadings[code] = 0;
      return { ticker: sec.ticker, sector: sec.sector, subTheme: sec.subTheme, weight: sec.weight, loadings };
    }
    const fit = multivariateOls(ySlice, xSlice, weights);
    const loadings: Partial<Record<FactorCode, number>> = {};
    for (let fi = 0; fi < factorCodes.length; fi++) {
      loadings[factorCodes[fi]!] = fit.betas[fi] ?? 0;
    }
    return {
      ticker: sec.ticker,
      sector: sec.sector,
      subTheme: sec.subTheme,
      weight: sec.weight,
      loadings,
    };
  });
}
