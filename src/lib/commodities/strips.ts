import type { CurvePoint } from "@/types/commodities";

/**
 * Strip (multi-month average) math for the COMMODITIES tab: BAL/CAL strips,
 * rolling 12/36/60-month averages, and deltas between strip levels. All
 * functions are pure and null-safe: insufficient data returns null, never
 * throws. `points` arrays are ordered ascending by contractMonth but may
 * have gaps and any length — nothing here assumes 60 months.
 */

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Average of points[startIdx .. endIdxExclusive). Null when the slice is empty. */
export function stripAvgByIndex(
  points: CurvePoint[],
  startIdx: number,
  endIdxExclusive: number,
): number | null {
  return avg(points.slice(startIdx, endIdxExclusive).map((p) => p.price));
}

/**
 * Balance-of-year strip: the average of contract months in the settle year
 * that are ≥ the first point's month (i.e. the remaining current-year months
 * present in the strip). December edge: when no current-year months remain
 * (strip already starts in January of the next year), avg is null — the
 * label is still "BAL-YY" from the settle year.
 */
export function balStrip(
  points: CurvePoint[],
  settleDateIso: string,
): { label: string; avg: number | null } {
  const settleYear = settleDateIso.slice(0, 4);
  const label = `BAL-${settleDateIso.slice(2, 4)}`;
  const startMonth = points[0]?.contractMonth;
  if (startMonth === undefined) return { label, avg: null };
  const values = points
    .filter(
      (p) => p.contractMonth.slice(0, 4) === settleYear && p.contractMonth >= startMonth,
    )
    .map((p) => p.price);
  return { label, avg: avg(values) };
}

/**
 * Calendar-year strip: the average of the months of `year` that exist in the
 * strip (partial coverage allowed — does not require all 12); null when none.
 */
export function calStrip(
  points: CurvePoint[],
  year: number,
): { label: string; avg: number | null } {
  const prefix = `${year}-`;
  const label = `CAL-${String(year % 100).padStart(2, "0")}`;
  const values = points
    .filter((p) => p.contractMonth.startsWith(prefix))
    .map((p) => p.price);
  return { label, avg: avg(values) };
}

/**
 * Rolling front strip: averages the first min(months, points.length) points.
 * `covered` reports how many months actually went into the average; avg is
 * null only when the strip is empty.
 */
export function rollingStrip(
  points: CurvePoint[],
  months: 12 | 36 | 60,
): { avg: number | null; covered: number } {
  const covered = Math.min(months, points.length);
  return { avg: stripAvgByIndex(points, 0, covered), covered };
}

/**
 * Delta between a current and prior strip level. abs = cur − prior (null
 * when either side is null); pct = abs / |prior| × 100, null when prior is
 * null or 0.
 */
export function stripDelta(
  cur: number | null,
  prior: number | null,
): { abs: number | null; pct: number | null } {
  if (cur === null || prior === null) return { abs: null, pct: null };
  const abs = cur - prior;
  const pct = prior === 0 ? null : (abs / Math.abs(prior)) * 100;
  return { abs, pct };
}
