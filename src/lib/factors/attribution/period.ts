/**
 * Period attribution summaries.
 * Buckets daily attribution into standard reporting periods.
 */
import type { AttributionDayPoint, PeriodAttributionSummary } from "@/types/factors";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

export type PeriodLabel = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

const PERIODS: PeriodLabel[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Calendar start date for a date-based period, or `null` for the count-based
 * trailing-day periods (1D/5D) which are sliced by observation count instead
 * (calendar-day math is wrong across weekends/holidays for tiny windows).
 */
export function periodStartDate(label: PeriodLabel, ref: Date): string | null {
  switch (label) {
    case "1D":
    case "5D":
      return null;
    case "1M": {
      const d = new Date(ref);
      d.setMonth(d.getMonth() - 1);
      return isoDate(d);
    }
    case "3M": {
      const d = new Date(ref);
      d.setMonth(d.getMonth() - 3);
      return isoDate(d);
    }
    case "6M": {
      const d = new Date(ref);
      d.setMonth(d.getMonth() - 6);
      return isoDate(d);
    }
    case "1Y": {
      const d = new Date(ref);
      d.setFullYear(d.getFullYear() - 1);
      return isoDate(d);
    }
  }
}

/** Trailing observation count for the count-based periods (1D/5D). */
function periodTrailingCount(label: PeriodLabel): number | null {
  if (label === "1D") return 1;
  if (label === "5D") return 5;
  return null;
}

export interface PeriodSlice {
  /** First index of the slice (inclusive). -1 when `dates` is empty. */
  startIndex: number;
  /** Last index of the slice (inclusive) = dates.length - 1. -1 when empty. */
  endIndex: number;
  /** ISO date at `startIndex`, or "" when empty. */
  startDate: string;
  /** ISO date at `endIndex`, or "" when empty. */
  endDate: string;
}

/**
 * Resolve the `[startIndex, endIndex]` slice of a sorted-ascending date array
 * that belongs to a trailing reporting period.
 *
 * Rules (single source of truth, shared by portfolio + per-stock paths):
 *   - 1D / 5D  → trailing observation COUNT (1 or 5 days), because calendar
 *                math is wrong across weekends/holidays for tiny windows.
 *   - 1M..1Y   → calendar offset from the reference date (last date by
 *                default), inclusive of the first trading day on/after it.
 *
 * @param dates    Sorted-ascending ISO date strings (YYYY-MM-DD or ISO datetime).
 * @param label    Reporting-period label.
 * @param refDate  Reference date for calendar offsets; defaults to the last date.
 */
export function resolvePeriodSlice(
  dates: string[],
  label: PeriodLabel,
  refDate?: string,
): PeriodSlice {
  if (dates.length === 0) {
    return { startIndex: -1, endIndex: -1, startDate: "", endDate: "" };
  }
  const endIndex = dates.length - 1;
  const endDate = dates[endIndex]!;

  const count = periodTrailingCount(label);
  let startIndex: number;
  if (count != null) {
    startIndex = Math.max(0, dates.length - count);
  } else {
    const ref = refDate ? new Date(refDate) : new Date(endDate);
    const start = periodStartDate(label, ref)!;
    // First index whose date is on/after the calendar start.
    let i = dates.findIndex((d) => d >= start);
    if (i < 0) i = 0;
    startIndex = i;
  }

  return {
    startIndex,
    endIndex,
    startDate: dates[startIndex]!,
    endDate,
  };
}

/**
 * Compute period attribution summaries from a daily attribution series.
 *
 * @param daily         Sorted daily attribution points.
 * @param factorCodes   Factor codes present in `d.byFactor`.
 * @param refDate       Reference date (last date in series), defaults to today.
 */
export function computePeriodAttribution(
  daily: AttributionDayPoint[],
  factorCodes: FactorCode[],
  refDate?: Date,
): PeriodAttributionSummary[] {
  if (!daily.length) return [];

  // Default ref date to the LAST daily attribution date (not today). Calendar
  // periods (1M…1Y) anchor to the data's most recent observation, so the
  // bucket boundaries line up with the realised series even when the series
  // is a day or two stale (typical Yahoo / KF publish lag). Matches the
  // anchor semantics in `resolvePeriodSlice` used by the per-stock path.
  const lastDate = daily[daily.length - 1]!.date;
  const ref = refDate ?? new Date(`${lastDate}T12:00:00Z`);

  return PERIODS.map((label) => {
    const start = periodStartDate(label, ref);
    const slice =
      start != null
        ? daily.filter((d) => d.date >= start)
        : daily.slice(-(label === "1D" ? 1 : 5));
    const startDate = start ?? (slice.length ? slice[0]!.date : lastDate);

    let totalReturn = 0;
    let factorReturn = 0;
    let rfReturn = 0;
    let alpha = 0;
    const byFactorSum: Record<string, number> = {};

    for (const d of slice) {
      totalReturn += d.portExcessReturn + d.rfContrib;
      factorReturn += Object.values(d.byFactor).reduce((s, v) => s + v, 0);
      rfReturn += d.rfContrib;
      alpha += d.alpha;
      for (const [code, contrib] of Object.entries(d.byFactor)) {
        byFactorSum[code] = (byFactorSum[code] ?? 0) + contrib;
      }
    }

    const byFactor = factorCodes.map((code) => {
      const contribution = byFactorSum[code] ?? 0;
      return {
        code,
        label: getFactorDef(code).label,
        contribution,
        pct: Math.abs(totalReturn) > 1e-10 ? contribution / Math.abs(totalReturn) : 0,
      };
    });

    return {
      label,
      startDate,
      endDate: lastDate,
      totalReturn,
      factorReturn,
      rfReturn,
      alpha,
      byFactor,
    };
  });
}
