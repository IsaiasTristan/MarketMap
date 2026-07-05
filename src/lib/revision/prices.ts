/**
 * Engine 1 — pure weekly price-grid math. Builds the snapshot-date grid
 * (actual RevisionSnapshot dates kept verbatim — the weekly job is
 * staleness-gated, so the cadence is irregular — extended backward in 7-day
 * steps), samples daily EOD bars onto it, and computes trailing grid-step
 * returns. "4w" everywhere in this engine means 4 GRID STEPS, not exactly 28
 * calendar days. No I/O.
 */
import { REVISION_THRESHOLDS } from "@/lib/revision/config";

export interface EodBarLike {
  date: string; // YYYY-MM-DD ascending or not — sorted internally
  close: number;
}

export interface WeeklyClose {
  snapshotDate: string;
  close: number | null;
  priceDate: string | null; // actual bar date used; null when too stale / absent
}

export interface TrailingReturns {
  ret1w: number | null;
  ret4w: number | null;
  ret13w: number | null;
}

const DAY_MS = 86_400_000;

function isoAddDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The weekly grid: every actual snapshot date verbatim (deduped, ascending),
 * extended backward from the earliest one in 7-day steps for `extendWeeks`
 * weeks. With no actual dates the grid is empty.
 */
export function weeklyGridDates(actualSnapshotIsos: string[], extendWeeks: number): string[] {
  const actual = [...new Set(actualSnapshotIsos)].sort();
  if (actual.length === 0) return [];
  const earliest = actual[0]!;
  const back: string[] = [];
  for (let w = extendWeeks; w >= 1; w--) back.push(isoAddDays(earliest, -7 * w));
  return [...back, ...actual];
}

/**
 * Sample daily bars onto the grid: for each grid date take the last bar on or
 * before it. A close is null when the freshest such bar is more than
 * `maxStaleDays` old (delisted / not yet listed / long halt).
 */
export function weeklyCloseSeries(
  bars: EodBarLike[],
  grid: string[],
  maxStaleDays: number = REVISION_THRESHOLDS.priceGridStaleDays,
): WeeklyClose[] {
  const sorted = bars
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: WeeklyClose[] = [];
  let lo = 0; // sorted[lo-1] is the last bar <= previous grid date; grid is ascending
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.date <= gridDate) lo++;
    const bar = lo > 0 ? sorted[lo - 1]! : null;
    if (!bar) {
      out.push({ snapshotDate: gridDate, close: null, priceDate: null });
      continue;
    }
    const staleDays =
      (new Date(`${gridDate}T00:00:00Z`).getTime() - new Date(`${bar.date}T00:00:00Z`).getTime()) / DAY_MS;
    if (staleDays > maxStaleDays) {
      out.push({ snapshotDate: gridDate, close: null, priceDate: null });
    } else {
      out.push({ snapshotDate: gridDate, close: bar.close, priceDate: bar.date });
    }
  }
  return out;
}

/**
 * Trailing simple returns over 1 / 4 / 13 grid steps at each grid index.
 * Null-propagating: a return is null when either endpoint close is missing or
 * the lookback runs off the front of the series.
 */
export function trailingReturns(closes: Array<number | null>): TrailingReturns[] {
  const at = (i: number): number | null => {
    const v = i >= 0 && i < closes.length ? closes[i] : null;
    return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  };
  const ret = (i: number, steps: number): number | null => {
    const a = at(i - steps);
    const b = at(i);
    return a !== null && b !== null ? b / a - 1 : null;
  };
  return closes.map((_, i) => ({
    ret1w: ret(i, 1),
    ret4w: ret(i, 4),
    ret13w: ret(i, 13),
  }));
}
