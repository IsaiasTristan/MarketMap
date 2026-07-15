/**
 * Date/label formatting for the COMMODITIES tab. All contract months are
 * "YYYY-MM" keys internally; every human-facing label is an explicit date
 * (M/D/YY or M/1/YY) — tenor notation like M1/M6 is banned from the UI.
 * Pure string math on ISO inputs: no Date construction, no timezone traps.
 */

/** "YYYY-MM" key from an ISO date ("2026-08-01" → "2026-08"). */
export function monthKeyFromIso(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Contract-month display label: "2026-08" → "8/1/26". */
export function contractMonthLabel(monthKey: string): string {
  const y = monthKey.slice(2, 4);
  const m = Number(monthKey.slice(5, 7));
  return `${m}/1/${y}`;
}

/** Short M/D/YY date label: "2026-07-13" → "7/13/26". */
export function shortDate(isoDate: string): string {
  const y = isoDate.slice(2, 4);
  const m = Number(isoDate.slice(5, 7));
  const d = Number(isoDate.slice(8, 10));
  return `${m}/${d}/${y}`;
}

/** Adds `n` calendar months to a "YYYY-MM" key (n may be negative). */
export function addMonths(monthKey: string, n: number): string {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Whole calendar months from `a` to `b` ("2026-08" → "2026-10" = 2). */
export function monthDiff(a: string, b: string): number {
  const ya = Number(a.slice(0, 4)), ma = Number(a.slice(5, 7));
  const yb = Number(b.slice(0, 4)), mb = Number(b.slice(5, 7));
  return (yb - ya) * 12 + (mb - ma);
}
