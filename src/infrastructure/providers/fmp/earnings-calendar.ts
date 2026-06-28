/** Earnings calendar — next report date per name (proximity weighting input). */
import { fmpGetJson, isoDate, num } from "./fmp-client";
import type { FmpEarningsCalendarRaw, FmpEarningsRaw, NormalizedEarnings } from "./types";

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

/**
 * Per-symbol reported earnings history (actuals + the consensus immediately
 * before each report). FMP /stable/earnings returns descending by date; we
 * return ascending (oldest -> newest). The estimate is FMP's pre-announcement
 * consensus — never the post-release update.
 */
export async function fetchEarningsHistory(
  symbol: string,
  limit = 20,
): Promise<NormalizedEarnings[]> {
  const rows = await fmpGetJson<FmpEarningsRaw[]>("/stable/earnings", { symbol, limit });
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r): NormalizedEarnings | null => {
      const reportDate = isoDate(r.date);
      if (!reportDate || !r.symbol) return null;
      return {
        ticker: r.symbol.toUpperCase(),
        reportDate,
        epsActual: num(r.epsActual),
        epsEstimated: num(r.epsEstimated),
        revenueActual: num(r.revenueActual),
        revenueEstimated: num(r.revenueEstimated),
      };
    })
    .filter((r): r is NormalizedEarnings => r !== null)
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate));
}
