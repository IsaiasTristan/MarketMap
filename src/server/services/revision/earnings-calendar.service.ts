/**
 * Engine 1 — earnings calendar loader. Builds a ticker -> next earnings date
 * map (proximity-to-earnings weighting input for the signal layer).
 */
import { fetchEarningsCalendar } from "@/infrastructure/providers/fmp";

const DEFAULT_LOOKAHEAD_DAYS = 120;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Map of universe ticker -> earliest upcoming earnings date (YYYY-MM-DD). */
export async function loadNextEarnings(
  universeTickers: string[],
  fromDate: string,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
): Promise<Map<string, string>> {
  const universe = new Set(universeTickers);
  const entries = await fetchEarningsCalendar(fromDate, addDays(fromDate, lookaheadDays));
  const next = new Map<string, string>();
  for (const e of entries) {
    if (!universe.has(e.ticker) || e.date < fromDate) continue;
    const existing = next.get(e.ticker);
    if (!existing || e.date < existing) next.set(e.ticker, e.date);
  }
  return next;
}
