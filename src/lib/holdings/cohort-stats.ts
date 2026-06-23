import type { ScreenerColumnStats } from "@/lib/factors/screener/types";

/** Build cohort stats compatible with {@link computePctRank}. */
export function buildCohortStats(values: number[]): ScreenerColumnStats {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) {
    return {
      n: 0,
      mean: Number.NaN,
      sd: Number.NaN,
      min: Number.NaN,
      max: Number.NaN,
      sortedValues: [],
    };
  }
  let sum = 0;
  for (const v of finite) sum += v;
  const mean = sum / n;
  let sumSq = 0;
  for (const v of finite) {
    const d = v - mean;
    sumSq += d * d;
  }
  const sd = n >= 2 ? Math.sqrt(sumSq / (n - 1)) : Number.NaN;
  const sorted = finite.slice().sort((a, b) => a - b);
  return {
    n,
    mean,
    sd,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    sortedValues: sorted,
  };
}

/** Group 1D returns by string key (sector or subTheme). */
export function groupReturnsByKey(
  entries: { key: string; chg1dPct: number }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const { key, chg1dPct } of entries) {
    if (!Number.isFinite(chg1dPct)) continue;
    const k = key.trim() || "Other";
    const arr = map.get(k) ?? [];
    arr.push(chg1dPct);
    map.set(k, arr);
  }
  return map;
}
