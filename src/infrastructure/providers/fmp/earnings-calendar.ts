/** Earnings calendar — next report date per name (proximity weighting input). */
import { fmpGetJson, isoDate, num } from "./fmp-client";
import type { FmpEarningsCalendarRaw } from "./types";

export interface EarningsCalendarEntry {
  ticker: string;
  date: string;
  epsEstimated: number | null;
  revenueEstimated: number | null;
}

/** Fetch the (global) earnings calendar for a date window. Filter to the
 * universe in the ingestion layer. Dates are inclusive YYYY-MM-DD. */
export async function fetchEarningsCalendar(
  from: string,
  to: string,
): Promise<EarningsCalendarEntry[]> {
  const rows = await fmpGetJson<FmpEarningsCalendarRaw[]>("/stable/earnings-calendar", { from, to });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): EarningsCalendarEntry | null => {
      const date = isoDate(r.date);
      if (!date || !r.symbol) return null;
      return {
        ticker: r.symbol.toUpperCase(),
        date,
        epsEstimated: num(r.epsEstimated),
        revenueEstimated: num(r.revenueEstimated),
      };
    })
    .filter((r): r is EarningsCalendarEntry => r !== null);
}
