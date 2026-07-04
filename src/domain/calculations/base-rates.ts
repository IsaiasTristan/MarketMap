/**
 * Pattern base rates (Part 4) — pure, DB-free.
 *
 * Forward-return statistics for a cohort of pattern occurrences (a lifecycle
 * stage, a stasis-break, or a calibration threshold). Returns are EXCESS vs a
 * benchmark, from split-adjusted closes. Entry timing is the FILING/availability
 * date (never the period-end) so there is no lookahead — `priceAsOf` only ever
 * returns a close on/after the requested date.
 *
 * A cohort with N < BASE_RATE_MIN_N is reported as insufficient (never a number
 * without its N).
 */

export const BASE_RATE_MIN_N = 30;

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Forward excess return = stock total return − benchmark total return. */
export function forwardExcessReturn(
  entryPx: number,
  exitPx: number,
  benchEntry: number,
  benchExit: number,
): number | null {
  if (!(entryPx > 0) || !(exitPx > 0) || !(benchEntry > 0) || !(benchExit > 0)) return null;
  return round4(exitPx / entryPx - 1 - (benchExit / benchEntry - 1));
}

export interface CohortSummary {
  excessReturn: number | null; // mean forward excess return (fraction)
  hitRate: number | null; // fraction of the cohort with positive excess
  n: number;
  sufficient: boolean; // n >= minN
}

/** Summarize a cohort's forward excess returns; gates on minimum N. */
export function summarizeCohort(excess: Array<number | null>, minN: number = BASE_RATE_MIN_N): CohortSummary {
  const xs = excess.filter((x): x is number => x != null && Number.isFinite(x));
  const n = xs.length;
  if (n < minN) return { excessReturn: null, hitRate: null, n, sufficient: false };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const hit = xs.filter((x) => x > 0).length / n;
  return { excessReturn: round4(mean), hitRate: round4(hit), n, sufficient: true };
}

export interface PricePoint {
  t: number; // trade date, ms since epoch
  px: number; // split-adjusted close
}

/**
 * First split-adjusted close on/after `asOfMs` in an ascending-by-time series.
 * NEVER returns a price before `asOfMs` — this is what makes entry timing
 * lookahead-free (we buy at the first available close once the 13F is public).
 */
export function priceAsOf(series: PricePoint[], asOfMs: number): number | null {
  // binary search for the first t >= asOfMs
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.t < asOfMs) lo = mid + 1;
    else hi = mid;
  }
  const p = series[lo];
  return p && p.px > 0 ? p.px : null;
}

/** Human label for a base-rate line; null-N-safe. */
export function baseRateLabel(patternLabel: string, s: CohortSummary, horizon: string): string {
  if (!s.sufficient || s.excessReturn == null) return `${patternLabel}: insufficient history (n=${s.n})`;
  const pct = (s.excessReturn * 100).toFixed(1);
  const hit = s.hitRate != null ? `, ${Math.round(s.hitRate * 100)}% hit` : "";
  const sign = s.excessReturn >= 0 ? "+" : "";
  return `${patternLabel}: ${sign}${pct}% excess next ${horizon} (n=${s.n}${hit})`;
}
