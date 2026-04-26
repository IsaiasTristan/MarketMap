/**
 * Factor data freshness diagnostic.
 *
 * Detects factors whose most recent published row lags the freshest day in
 * the loaded factor matrix by more than `thresholdTradingDays` weekday days.
 * Pure function — no DB / HTTP — so it slots into both the snapshot
 * (`factor-per-stock.service`) and timeseries (`factor-per-stock-timeseries`)
 * services without dragging in side effects.
 *
 * Why compare factors against each other and not against "today":
 *   • Avoids false positives from weekends / holidays / timezone drift.
 *   • Correctly distinguishes "the whole system is one weekend behind" (no
 *     warning) from "this one factor is six weeks behind because the upstream
 *     publisher (KF / AQR) hasn't released" (clear warning).
 *
 * The reference date is the maximum date present anywhere in `factorByDate`
 * or `rfByDate`. This is the freshest trading day the system has any data
 * for and is the natural lag baseline for every factor in the model.
 */
import type { FactorCode, FactorStalenessEntry } from "@/types/factors";

const DEFAULT_THRESHOLD_TRADING_DAYS = 3;

/**
 * Count weekday-only dates strictly after `fromIso` up to and including
 * `toIso`. Returns 0 when `fromIso >= toIso`. Same trading-day semantics as
 * `factor-pipeline.detectGap` (Mon–Fri only — does not consult an exchange
 * holiday calendar; see KNOWN LIMITATIONS in module docstring).
 */
export function tradingDayDiff(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso || fromIso >= toIso) return 0;
  let count = 0;
  const cur = new Date(`${fromIso}T00:00:00Z`);
  const stop = new Date(`${toIso}T00:00:00Z`);
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= stop) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

export interface DetectFactorStalenessOptions {
  /** Trading-day lag at or below which a factor is considered fresh. Default 3. */
  thresholdTradingDays?: number;
  /**
   * Optional risk-free rate matrix. Folded into the reference-date computation
   * AND checked for staleness — RF is not a member of `usableFactors` in any
   * model preset but its lag matters because the per-stock service silently
   * defaults `rfByDate.get(d) ?? 0` for missing entries, which inflates
   * "excess" return for any date past the last RF print.
   */
  rfByDate?: Map<string, number>;
}

/**
 * Identify factors whose latest row trails the freshest day in the matrix
 * by more than the configured trading-day threshold.
 *
 * KNOWN LIMITATIONS:
 *   • Mon–Fri counter only; US holidays count as 1 trading day. A factor
 *     missing exactly across a 1-day-holiday weekend will read 1 day stale.
 *     Not a problem at the default threshold of 3.
 *   • Treats null / NaN / non-finite values as "no row".
 *
 * @param factorByDate - per-date map of factor code → numeric value
 * @param usableFactors - the active factor set for the regression
 * @param options - threshold + optional RF matrix
 * @returns entries sorted by lag descending, then factor code ascending
 */
export function detectFactorStaleness(
  factorByDate: Map<string, Record<string, number>>,
  usableFactors: FactorCode[],
  options?: DetectFactorStalenessOptions,
): FactorStalenessEntry[] {
  const threshold = options?.thresholdTradingDays ?? DEFAULT_THRESHOLD_TRADING_DAYS;
  const rfByDate = options?.rfByDate;

  let referenceDate = "";
  for (const d of factorByDate.keys()) {
    if (d > referenceDate) referenceDate = d;
  }
  if (rfByDate) {
    for (const d of rfByDate.keys()) {
      if (d > referenceDate) referenceDate = d;
    }
  }
  if (!referenceDate) return [];

  const lastByFactor = new Map<FactorCode, string>();
  for (const [d, row] of factorByDate.entries()) {
    for (const code of usableFactors) {
      const v = row[code];
      if (v == null || !Number.isFinite(v)) continue;
      const cur = lastByFactor.get(code);
      if (cur == null || d > cur) lastByFactor.set(code, d);
    }
  }

  const out: FactorStalenessEntry[] = [];
  for (const code of usableFactors) {
    const lastDate = lastByFactor.get(code);
    if (!lastDate) continue;
    const lag = tradingDayDiff(lastDate, referenceDate);
    if (lag > threshold) {
      out.push({ factor: code, lastDate, referenceDate, lagTradingDays: lag });
    }
  }

  if (rfByDate && rfByDate.size > 0) {
    let rfLast = "";
    for (const [d, v] of rfByDate.entries()) {
      if (v == null || !Number.isFinite(v)) continue;
      if (d > rfLast) rfLast = d;
    }
    if (rfLast) {
      const lag = tradingDayDiff(rfLast, referenceDate);
      if (lag > threshold) {
        out.push({ factor: "RF", lastDate: rfLast, referenceDate, lagTradingDays: lag });
      }
    }
  }

  out.sort(
    (a, b) =>
      b.lagTradingDays - a.lagTradingDays || a.factor.localeCompare(b.factor),
  );

  return out;
}
