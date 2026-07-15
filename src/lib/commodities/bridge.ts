import type { BridgePoint, CurvePoint, HistoryMonthDto } from "@/types/commodities";

/**
 * Merges realized monthly history with the forward strip into one series for
 * the bridged chart. The seam sits at the strip's FIRST contract month:
 * history months strictly before it are kept as "HIST" (so a settle-month
 * realized row survives when the prompt has already rolled to the next
 * month — e.g. WTI settle 7/13 with an Aug prompt keeps the realized July
 * settle), then every strip point follows as "FUT". A history month that
 * collides with any strip month is dropped — the strip wins. Output
 * ascending by month with no duplicates across the seam. Pure.
 *
 * `latestSettleIso` is accepted for the divider label the callers render but
 * no longer defines the data boundary.
 */
export function mergeHistoryAndStrip(
  history: HistoryMonthDto[],
  strip: CurvePoint[],
  _latestSettleIso: string,
): BridgePoint[] {
  const firstFutMonth = strip[0]?.contractMonth ?? null;
  const futMonths = new Set(strip.map((p) => p.contractMonth));

  const hist: BridgePoint[] = history
    .filter((h) => (firstFutMonth === null || h.month < firstFutMonth) && !futMonths.has(h.month))
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((h) => ({ month: h.month, price: h.avgSettle, type: "HIST" as const }));

  const fut: BridgePoint[] = strip.map((p) => ({
    month: p.contractMonth,
    price: p.price,
    type: "FUT" as const,
  }));

  return [...hist, ...fut];
}
