import { monthKeyFromIso } from "./format";

/**
 * Buckets daily settles into calendar-month averages for the realized-history
 * store (CommodityHistoryMonthly). Pure: takes { date, price } rows, returns
 * one row per month present. Months with no settles simply don't appear —
 * never interpolated.
 */
export function monthlyAverages(
  dailySettles: { date: string; price: number }[],
): { month: string; avgSettle: number }[] {
  const sums = new Map<string, { total: number; n: number }>();
  for (const row of dailySettles) {
    if (!Number.isFinite(row.price)) continue;
    const key = monthKeyFromIso(row.date);
    const cur = sums.get(key) ?? { total: 0, n: 0 };
    cur.total += row.price;
    cur.n += 1;
    sums.set(key, cur);
  }
  return [...sums.entries()]
    .map(([month, { total, n }]) => ({ month, avgSettle: total / n }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}
