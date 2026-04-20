/**
 * Period attribution summaries.
 * Buckets daily attribution into standard reporting periods.
 */
import type { AttributionDayPoint, PeriodAttributionSummary } from "@/types/factors";
import type { FactorCode } from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

export type PeriodLabel = "1D" | "5D" | "MTD" | "QTD" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ITD";

interface PeriodSpec {
  label: PeriodLabel;
  startDate: (refDate: Date) => Date;
}

function addTradingDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() - n * 1.4); // rough calendar approximation for start
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function quarterStart(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
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

  const ref = refDate ?? new Date();
  const lastDate = daily[daily.length - 1]!.date;
  const firstDate = daily[0]!.date;

  function periodStart(label: PeriodLabel): string {
    switch (label) {
      case "1D":
        return lastDate;
      case "5D": {
        const slice = daily.slice(-5);
        return slice[0]?.date ?? lastDate;
      }
      case "MTD":
        return isoDate(monthStart(ref));
      case "QTD":
        return isoDate(quarterStart(ref));
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
      case "YTD":
        return `${ref.getFullYear()}-01-01`;
      case "1Y": {
        const d = new Date(ref);
        d.setFullYear(d.getFullYear() - 1);
        return isoDate(d);
      }
      case "ITD":
        return firstDate;
    }
  }

  const PERIODS: PeriodLabel[] = ["1D", "5D", "MTD", "QTD", "1M", "3M", "6M", "YTD", "1Y", "ITD"];

  return PERIODS.map((label) => {
    const start = periodStart(label);
    const slice = daily.filter((d) => d.date >= start);

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
      startDate: start,
      endDate: lastDate,
      totalReturn,
      factorReturn,
      rfReturn,
      alpha,
      byFactor,
    };
  });
}
