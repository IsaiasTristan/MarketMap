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
  /**
   * Close of the first trading day STRICTLY AFTER the grid date — the entry
   * price for every forward-return measurement. Revision events dated on the
   * snapshot date can post after that day's close, so entering at t would book
   * a move the signal could not have been traded on. Null when no bar lands
   * within `maxEntryGapDays` (holiday cluster, halt, delisting).
   */
  closeNext: number | null;
  closeNextDate: string | null;
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
 * before it (the close), plus the first bar strictly after it (the t+1 entry).
 * A close is null when the freshest such bar is more than `maxStaleDays` old
 * (delisted / not yet listed / long halt); an entry is null when no bar lands
 * within `maxEntryGapDays`.
 */
export function weeklyCloseSeries(
  bars: EodBarLike[],
  grid: string[],
  maxStaleDays: number = REVISION_THRESHOLDS.priceGridStaleDays,
  maxEntryGapDays: number = REVISION_THRESHOLDS.entryGapMaxDays,
): WeeklyClose[] {
  const sorted = bars
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const daysBetween = (fromIso: string, toIso: string) =>
    (new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / DAY_MS;
  const out: WeeklyClose[] = [];
  let lo = 0; // sorted[lo-1] is the last bar <= previous grid date; grid is ascending
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.date <= gridDate) lo++;
    const nextBar = lo < sorted.length ? sorted[lo]! : null;
    const entryOk = nextBar !== null && daysBetween(gridDate, nextBar.date) <= maxEntryGapDays;
    const closeNext = entryOk ? nextBar!.close : null;
    const closeNextDate = entryOk ? nextBar!.date : null;

    const bar = lo > 0 ? sorted[lo - 1]! : null;
    if (!bar || daysBetween(bar.date, gridDate) > maxStaleDays) {
      out.push({ snapshotDate: gridDate, close: null, priceDate: null, closeNext, closeNextDate });
      continue;
    }
    out.push({
      snapshotDate: gridDate,
      close: bar.close,
      priceDate: bar.date,
      closeNext,
      closeNextDate,
    });
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

export interface ForwardReturnSeries {
  /** values[i] = closeNext[i+h] / closeNext[i] - 1, null when either end is missing. */
  values: Array<number | null>;
  /** Slots where the horizon fits in the grid but an entry price was missing. */
  dropped: number;
  /** Slots where the horizon fits AND both entry prices exist. */
  measured: number;
}

/**
 * Forward returns on the t+1 entry chain — the ONE definition used by the
 * signal lab, Validation and the screen rows.
 *
 * Both ends are entry prices (`closeNext`), so a 4-week return spans exactly
 * four grid steps of tradeable-at-the-same-time-of-day prices. Mixing a
 * snapshot close at one end with an entry close at the other would silently
 * add or remove a day of return at every horizon. Ticker-weeks without an
 * entry price are dropped and counted rather than filled — the count feeds the
 * survivorship note.
 */
export function forwardReturns(
  closeNext: Array<number | null>,
  horizon: number,
): ForwardReturnSeries {
  const at = (i: number): number | null => {
    const v = closeNext[i];
    return v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  };
  const values: Array<number | null> = new Array(closeNext.length).fill(null);
  let dropped = 0;
  let measured = 0;
  for (let i = 0; i + horizon < closeNext.length; i++) {
    const a = at(i);
    const b = at(i + horizon);
    if (a === null || b === null) {
      dropped++;
      continue;
    }
    values[i] = b / a - 1;
    measured++;
  }
  return { values, dropped, measured };
}
