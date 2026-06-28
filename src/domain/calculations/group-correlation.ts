import { pearsonCorr } from "./beta";

/**
 * A named group (sector / sub-theme) and its daily return series keyed by
 * trade date (YYYY-MM-DD). Each value is the group's equal-weight average
 * daily simple return for that date.
 */
export interface ReturnGroup {
  key: string;
  returnsByDate: Map<string, number>;
}

export interface GroupCorrelationResult {
  /** Group keys in the same order as the matrix rows / columns. */
  labels: string[];
  /** Symmetric correlation matrix; diagonal is 1. */
  matrix: number[][];
  /** Size of the shared trading-day window the correlations were taken over. */
  obs: number;
  /** Latest trade date represented across all groups, or null when empty. */
  asOf: string | null;
}

/**
 * Build a Pearson correlation matrix across group daily-return series.
 *
 * The shared window is the last `window` trading dates that appear in ANY
 * group (the union calendar). Each off-diagonal cell is computed pairwise on
 * the dates BOTH groups have within that window — robust to heterogeneous
 * coverage (a sub-theme that started trading mid-window still correlates over
 * its overlap rather than dropping the whole pair). Diagonals are forced to 1;
 * a pair with no overlap (or zero variance) yields 0 from `pearsonCorr`.
 */
export function computeGroupReturnCorrelations(
  groups: ReturnGroup[],
  window: number,
): GroupCorrelationResult {
  const k = groups.length;
  if (k === 0) return { labels: [], matrix: [], obs: 0, asOf: null };

  // Union calendar across all groups, ascending, trimmed to the last `window`.
  const allDates = new Set<string>();
  for (const g of groups) {
    for (const d of g.returnsByDate.keys()) allDates.add(d);
  }
  const sortedDates = [...allDates].sort();
  const windowDates =
    sortedDates.length > window ? sortedDates.slice(-window) : sortedDates;
  const asOf = windowDates.length ? windowDates[windowDates.length - 1]! : null;

  const matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    matrix[i]![i] = 1;
    for (let j = i + 1; j < k; j++) {
      const a: number[] = [];
      const b: number[] = [];
      const mi = groups[i]!.returnsByDate;
      const mj = groups[j]!.returnsByDate;
      for (const d of windowDates) {
        const va = mi.get(d);
        const vb = mj.get(d);
        if (
          va !== undefined &&
          vb !== undefined &&
          Number.isFinite(va) &&
          Number.isFinite(vb)
        ) {
          a.push(va);
          b.push(vb);
        }
      }
      const corr = a.length >= 2 ? pearsonCorr(a, b) : 0;
      matrix[i]![j] = corr;
      matrix[j]![i] = corr;
    }
  }

  return { labels: groups.map((g) => g.key), matrix, obs: windowDates.length, asOf };
}
