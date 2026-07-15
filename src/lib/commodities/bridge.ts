import type { BridgePoint, CurvePoint, HistoryMonthDto } from "@/types/commodities";
import { monthKeyFromIso } from "./format";

/**
 * Merges realized monthly history with the forward strip into one series for
 * the bridged chart. The seam sits exactly at the latest settle month:
 * history months strictly BEFORE the settle month are kept as "HIST" (a
 * history row for the settle month itself is dropped — it would be a partial
 * month duplicating the front of the curve), then every strip point follows
 * as "FUT". Output ascending by month with no duplicate months across the
 * seam. Pure.
 */
export function mergeHistoryAndStrip(
  history: HistoryMonthDto[],
  strip: CurvePoint[],
  latestSettleIso: string,
): BridgePoint[] {
  const settleMonth = monthKeyFromIso(latestSettleIso);
  const futMonths = new Set(strip.map((p) => p.contractMonth));

  const hist: BridgePoint[] = history
    .filter((h) => h.month < settleMonth && !futMonths.has(h.month))
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((h) => ({ month: h.month, price: h.avgSettle, type: "HIST" as const }));

  const fut: BridgePoint[] = strip.map((p) => ({
    month: p.contractMonth,
    price: p.price,
    type: "FUT" as const,
  }));

  return [...hist, ...fut];
}
