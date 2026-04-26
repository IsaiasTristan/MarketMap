/**
 * Factor data pipeline: gap detection, distribution-matching normalization,
 * and splice logic. Pure functions — no DB or HTTP I/O.
 *
 * Normalization spec: (raw − proxy_mean) / proxy_std × ff_std + ff_mean
 * Calibration window: 63 trading days from the tail of the French data.
 */

export interface FactorSeries {
  date: string;
  value: number;
}

const CALIBRATION_WINDOW = 63;

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Detect gap: returns number of trading days after the last FF date. */
export function detectGap(lastFfDate: string | null): {
  lastFfDate: string | null;
  gapExists: boolean;
  gapTradingDays: number;
} {
  if (!lastFfDate) return { lastFfDate: null, gapExists: true, gapTradingDays: 0 };

  const last = new Date(lastFfDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Count trading days (Mon–Fri) between lastFfDate+1 and today
  let count = 0;
  const cur = new Date(last);
  cur.setDate(cur.getDate() + 1);
  while (cur <= today) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }

  return { lastFfDate, gapExists: count > 0, gapTradingDays: count };
}

/**
 * Normalize proxy returns so their distribution matches the French factor.
 * Calibration is performed over the last CALIBRATION_WINDOW days of ff data.
 * Only proxy returns AFTER lastFfDate are normalized.
 *
 * @param ffSeries  Official French factor rows, ascending by date
 * @param proxySeries  ETF proxy returns, ascending by date (may overlap with FF)
 * @param lastFfDate  ISO date string of last French publication
 */
export function normalizeProxyToFf(
  ffSeries: FactorSeries[],
  proxySeries: FactorSeries[],
  lastFfDate: string,
): FactorSeries[] {
  // Step 1: calibration window from FF tail
  const ffCal = ffSeries.slice(-CALIBRATION_WINDOW);
  const ffCalDates = new Set(ffCal.map((r) => r.date));

  // Step 2: FF calibration stats
  const ffValues = ffCal.map((r) => r.value);
  const ffMean = mean(ffValues);
  const ffStd = std(ffValues);

  // Step 3: proxy over calibration dates (overlap period)
  const proxyCal = proxySeries.filter((r) => ffCalDates.has(r.date));
  const proxyCalValues = proxyCal.map((r) => r.value);
  const proxyMean = mean(proxyCalValues);
  const proxyStd = std(proxyCalValues);

  // Step 4: gap-period proxy (dates after lastFfDate)
  const gapProxy = proxySeries.filter((r) => r.date > lastFfDate);

  // Step 5: normalize
  const normalized = gapProxy.map((r) => ({
    date: r.date,
    value:
      proxyStd > 0
        ? ((r.value - proxyMean) / proxyStd) * ffStd + ffMean
        : r.value - proxyMean + ffMean,
  }));

  return normalized;
}

/**
 * Splice FF series with normalized proxy gap returns.
 * Deduplicates on date (FF takes priority).
 */
export function buildFactorSeries(
  ffSeries: FactorSeries[],
  normalizedGap: FactorSeries[],
): FactorSeries[] {
  const map = new Map<string, FactorSeries>();
  for (const r of ffSeries) map.set(r.date, r);
  for (const r of normalizedGap) {
    if (!map.has(r.date)) map.set(r.date, r);
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calibrate a level series (e.g. DGS1MO RF) to a Ken French level series
 * by an additive shift fitted on the trailing 63-day overlap.
 *
 * For RF we deliberately use mean-shift instead of the
 * `normalizeProxyToFf` z-score approach used for return series:
 *   • RF is a level (annualized rate), not a return — its variance is
 *     near-zero on most days, so dividing by the proxy standard
 *     deviation produces unstable ratios.
 *   • DGS1MO and KF's RF differ by a small persistent level (~1-3 bp
 *     from 360 vs 365 day count + Ibbotson construction). A single
 *     additive shift captures that without re-scaling the term
 *     structure.
 *
 * Returns the shift (additive offset to add to FRED values) and the
 * count of overlapping observations actually used. If fewer than
 * `minOverlap` overlapping days are available, returns shift = 0 so
 * the caller still passes through raw FRED values.
 */
export function calibrateRfShift(
  ffRf: FactorSeries[],
  fredRf: FactorSeries[],
  lastFfDate: string,
  windowDays = CALIBRATION_WINDOW,
  minOverlap = 20,
): { shift: number; overlapDays: number } {
  if (!lastFfDate || !ffRf.length || !fredRf.length) {
    return { shift: 0, overlapDays: 0 };
  }
  const ffTail = ffRf.slice(-windowDays);
  const ffByDate = new Map<string, number>(ffTail.map((r) => [r.date, r.value]));
  const overlap: { ff: number; fred: number }[] = [];
  for (const r of fredRf) {
    const ff = ffByDate.get(r.date);
    if (ff === undefined) continue;
    if (r.date > lastFfDate) continue;
    overlap.push({ ff, fred: r.value });
  }
  if (overlap.length < minOverlap) return { shift: 0, overlapDays: overlap.length };
  const shift = mean(overlap.map((o) => o.ff - o.fred));
  return { shift, overlapDays: overlap.length };
}

/**
 * When FF publishes new data, replace proxy rows for those dates
 * with official FF values, then re-normalize the remaining gap.
 */
export function backfillWithFf(
  existing: FactorSeries[],
  newFfRows: FactorSeries[],
  ffSeries: FactorSeries[],
  proxySeries: FactorSeries[],
): FactorSeries[] {
  const newFfDates = new Set(newFfRows.map((r) => r.date));
  const lastFfDate = newFfRows[newFfRows.length - 1]?.date;

  if (!lastFfDate) return existing;

  // Remove old rows for newly published dates, then add official FF
  const filtered = existing.filter((r) => !newFfDates.has(r.date));
  const merged = [...filtered, ...newFfRows].sort((a, b) => a.date.localeCompare(b.date));

  // Re-normalize remaining gap
  const normalizedGap = normalizeProxyToFf(ffSeries, proxySeries, lastFfDate);

  return buildFactorSeries(merged, normalizedGap);
}
