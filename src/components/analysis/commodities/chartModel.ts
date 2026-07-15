"use client";
/**
 * Shared chart model for the COMMODITIES tab: the amber vintage ramp (exact
 * hex ladder from the mockup — latest deepest/thickest, older progressively
 * paler), display-window capping, and assembly of the combined
 * history+futures index domain the chart, data modal, and copy paths share.
 */
import { contractMonthLabel } from "@/lib/commodities/format";
import type { CurvePoint, CurveVintagesDto, VintageId } from "@/types/commodities";

export const VINTAGE_RAMP: Record<VintageId, { color: string; width: number; opacity: number }> = {
  LATEST: { color: "#ff8c00", width: 2.8, opacity: 1 },
  "1D": { color: "#ffa733", width: 1.5, opacity: 0.95 },
  "1W": { color: "#ffbe66", width: 1.3, opacity: 0.9 },
  "1M": { color: "#ffd699", width: 1.2, opacity: 0.85 },
  "3M": { color: "#ffe6bf", width: 1.1, opacity: 0.8 },
  "6M": { color: "#f6ecd9", width: 1.0, opacity: 0.72 },
  "1Y": { color: "#eeeee8", width: 1.0, opacity: 0.62 },
};

export const HISTORY_COLOR = "#8fa3b8"; // slate — never amber
export const HISTORY_REGION_FILL = "#0c1220";
export const DECK_COLOR = "#00bfff";

/** Chart/table display cap — the mockup preset is "1Y REALIZED + 60MO STRIP". */
export const STRIP_DISPLAY_MONTHS = 60;

export const VINTAGE_ORDER: VintageId[] = ["LATEST", "1D", "1W", "1M", "3M", "6M", "1Y"];

export interface ChartSeries {
  id: VintageId;
  resolvedDate: string;
  color: string;
  width: number;
  opacity: number;
  /** Aligned to the display months: null where this vintage has no point. */
  values: (number | null)[];
}

export interface ChartModel {
  /** History rows actually shown (window ∩ available). */
  history: { month: string; price: number }[];
  /** The latest strip's display months (≤ STRIP_DISPLAY_MONTHS). */
  months: string[];
  /** Combined domain labels: history months then futures months, as M/1/YY. */
  labels: string[];
  histLen: number;
  total: number;
  series: ChartSeries[]; // includes LATEST first
  latestValues: number[];
}

/**
 * Build the combined hist+fut model from the vintages DTO. Vintage strips are
 * aligned to the LATEST strip's contract months (same delivery month overlays
 * the same x position — older vintages start earlier, so their first months
 * fall off the left edge and their tail extends beyond; both are dropped).
 */
export function buildChartModel(
  dto: CurveVintagesDto,
  vintageToggles: Record<string, boolean>,
  historyMonths: number,
): ChartModel {
  const months = dto.latest.slice(0, STRIP_DISPLAY_MONTHS).map((p) => p.contractMonth);
  const latestValues = dto.latest.slice(0, STRIP_DISPLAY_MONTHS).map((p) => p.price);
  // History runs up to (not into) the strip's first month — a realized
  // settle-month row is kept when the prompt has rolled past it.
  const firstFutMonth = months[0] ?? null;
  const history =
    historyMonths > 0
      ? dto.history
          .filter((h) => firstFutMonth === null || h.month < firstFutMonth)
          .slice(-historyMonths)
          .map((h) => ({ month: h.month, price: h.avgSettle }))
      : [];

  const series: ChartSeries[] = [];
  if (vintageToggles.LATEST !== false) {
    series.push({
      id: "LATEST",
      resolvedDate: dto.latestSettleDate,
      ...VINTAGE_RAMP.LATEST,
      values: latestValues,
    });
  }
  for (const v of dto.vintages) {
    if (!vintageToggles[v.id]) continue;
    const byMonth = new Map(v.points.map((p) => [p.contractMonth, p.price]));
    series.push({
      id: v.id,
      resolvedDate: v.resolvedDate,
      ...VINTAGE_RAMP[v.id],
      values: months.map((m) => byMonth.get(m) ?? null),
    });
  }

  return {
    history,
    months,
    labels: [...history.map((h) => contractMonthLabel(h.month)), ...months.map(contractMonthLabel)],
    histLen: history.length,
    total: history.length + months.length,
    series,
    latestValues,
  };
}

/** Align a CurvePoint[] (e.g. a deck expansion) to the display months. */
export function alignToMonths(points: CurvePoint[], months: string[]): (number | null)[] {
  const byMonth = new Map(points.map((p) => [p.contractMonth, p.price]));
  return months.map((m) => byMonth.get(m) ?? null);
}
