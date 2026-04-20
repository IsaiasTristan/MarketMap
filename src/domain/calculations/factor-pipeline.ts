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
