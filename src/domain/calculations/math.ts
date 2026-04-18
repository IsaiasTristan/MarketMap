export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Sample standard deviation (Bessel correction), for daily return windows.
 */
export function standardDeviationSample(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}
