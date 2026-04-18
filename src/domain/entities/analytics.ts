export type MetricKind = "RETURN" | "EXCESS_RETURN" | "VOLATILITY" | "SHARPE";
export type RowLevel = "SECTOR" | "SUB_THEME" | "COMPANY";
export type BenchmarkCode = "SP500" | "NASDAQ" | "DOW";

export const METRIC_KINDS: readonly MetricKind[] = [
  "RETURN",
  "EXCESS_RETURN",
  "VOLATILITY",
  "SHARPE",
];

export const ROW_LEVELS: readonly RowLevel[] = [
  "SECTOR",
  "SUB_THEME",
  "COMPANY",
];

export const BENCHMARK_CODES: readonly BenchmarkCode[] = [
  "SP500",
  "NASDAQ",
  "DOW",
];
