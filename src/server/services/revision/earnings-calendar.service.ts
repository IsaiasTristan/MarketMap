/**
 * Engine 1 — earnings calendar loader. Builds a ticker -> next earnings date
 * map (proximity-to-earnings weighting input for the signal layer + the
 * CALENDAR tab / ER transition scan).
 *
 * FMP's /earnings-calendar caps each response at ~4000 rows and a wide window
 * gets truncated (observed: a 120-day request kept only the LATEST rows,
 * silently dropping the next few weeks — the worst possible failure for a
 * proximity signal). So the window is fetched in short slices, and any slice
 * that comes back at the cap is halved recursively.
 */
import { fetchEarningsCalendar, type EarningsCalendarEntry } from "@/infrastructure/providers/fmp";

const DEFAULT_LOOKAHEAD_DAYS = 120;
/** Slice width for calendar requests. Peak weeks are ~2-3k global rows. */
const SLICE_DAYS = 7;
/** FMP truncates around this row count; a slice at/above it is subdivided. */
const FMP_ROW_CAP = 4000;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

/** Fetch a window, halving recursively when the response hits the row cap. */
async function fetchWindow(from: string, to: string): Promise<EarningsCalendarEntry[]> {
  const rows = await fetchEarningsCalendar(from, to);
  if (rows.length < FMP_ROW_CAP || from === to) return rows;
  const mid = addDays(from, Math.floor(daysBetween(from, to) / 2));
  if (mid === from || mid >= to) return rows;
  const [a, b] = await Promise.all([fetchWindow(from, mid), fetchWindow(addDays(mid, 1), to)]);
  return [...a, ...b];
}

/** Map of universe ticker -> earliest upcoming earnings date (YYYY-MM-DD). */
export async function loadNextEarnings(
  universeTickers: string[],
  fromDate: string,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
): Promise<Map<string, string>> {
  const universe = new Set(universeTickers);
  const next = new Map<string, string>();
  for (let start = 0; start < lookaheadDays; start += SLICE_DAYS) {
    const from = addDays(fromDate, start);
    const to = addDays(fromDate, Math.min(start + SLICE_DAYS - 1, lookaheadDays));
    const entries = await fetchWindow(from, to);
    for (const e of entries) {
      if (!universe.has(e.ticker) || e.date < fromDate) continue;
      const existing = next.get(e.ticker);
      if (!existing || e.date < existing) next.set(e.ticker, e.date);
    }
  }
  return next;
}
