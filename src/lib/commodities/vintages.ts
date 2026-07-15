import type { ResolvedVintage, VintageId } from "@/types/commodities";

/**
 * Vintage lag definitions and snapshot-date resolution for the COMMODITIES
 * tab. A "vintage" is a prior forward-curve snapshot at a fixed trading-day
 * lag behind the latest settle. Weekday-only (Mon–Fri) trading-day convention,
 * matching `tradingDayDiff` in src/lib/factors/diagnostics/freshness.ts —
 * no exchange holiday calendar; a resolved vintage always snaps to the
 * nearest EARLIER available snapshot, never interpolates.
 *
 * Pure string/date math (UTC-safe): all Dates constructed from ISO with
 * T00:00:00Z, all output re-serialized to "YYYY-MM-DD".
 */

export const VINTAGE_DEFS: { id: VintageId; lagTradingDays: number }[] = [
  { id: "LATEST", lagTradingDays: 0 },
  { id: "1D", lagTradingDays: 1 },
  { id: "1W", lagTradingDays: 5 },
  { id: "1M", lagTradingDays: 21 },
  { id: "3M", lagTradingDays: 63 },
  { id: "6M", lagTradingDays: 126 },
  { id: "1Y", lagTradingDays: 251 },
];

/**
 * Walk back `n` weekdays (Mon–Fri) from an ISO date. `n = 0` returns the
 * input unchanged (even if it falls on a weekend — settles never do).
 */
export function subtractTradingDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve every lagged vintage (LATEST excluded) against the snapshot dates
 * actually on hand. For each def: targetDate = latest settle minus the lag in
 * trading days; resolvedDate = the nearest available date ≤ targetDate
 * (nearest earlier snapshot — never interpolate), or null when no snapshot
 * exists at or before the target. `availableSettleDatesIso` may be unsorted
 * and may contain duplicates.
 */
export function resolveVintages(
  latestSettleIso: string,
  availableSettleDatesIso: string[],
): ResolvedVintage[] {
  const out: ResolvedVintage[] = [];
  for (const def of VINTAGE_DEFS) {
    if (def.id === "LATEST") continue;
    const targetDate = subtractTradingDays(latestSettleIso, def.lagTradingDays);
    let resolvedDate: string | null = null;
    for (const d of availableSettleDatesIso) {
      if (d <= targetDate && (resolvedDate === null || d > resolvedDate)) {
        resolvedDate = d;
      }
    }
    out.push({
      id: def.id,
      lagTradingDays: def.lagTradingDays,
      targetDate,
      resolvedDate,
    });
  }
  return out;
}
