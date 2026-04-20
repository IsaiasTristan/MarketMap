/**
 * Factor correlation matrix from FactorReturnDaily data.
 */
import type { FactorCode } from "@/types/factors";
import { pearsonCorr } from "@/domain/calculations/beta";

/**
 * Compute k × k Pearson correlation matrix for factor returns.
 *
 * @param factorSeries  Map from FactorCode → daily return array (same-length, aligned).
 * @param factorCodes   Factor codes; determines row/column order.
 * @param window        Trailing window in trading days. Uses all data if series is shorter.
 */
export function computeFactorCorrelationMatrix(
  factorSeries: Map<string, number[]>,
  factorCodes: FactorCode[],
  window: number,
): number[][] {
  const k = factorCodes.length;
  const series = factorCodes.map((code) => {
    const full = factorSeries.get(code) ?? [];
    return full.length > window ? full.slice(-window) : full;
  });

  const matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const corr = i === j ? 1 : pearsonCorr(series[i]!, series[j]!);
      matrix[i]![j] = corr;
      matrix[j]![i] = corr;
    }
  }
  return matrix;
}
