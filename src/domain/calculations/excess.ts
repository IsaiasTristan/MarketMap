/**
 * Excess return = asset return - benchmark return for the same horizon
 * (both as decimals). Caller supplies pair of total returns; domain does not
 * impute missing benchmarks.
 */
export function excessReturn(
  assetReturn: number,
  benchmarkReturn: number
): number {
  return assetReturn - benchmarkReturn;
}
