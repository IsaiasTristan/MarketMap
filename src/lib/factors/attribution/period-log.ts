/**
 * Period attribution summaries in log space (Path B).
 *
 * Mirrors the bucket logic from {@link computePeriodAttribution} but
 * operates on log-return daily points so the period totals reconcile to
 * compounded realised excess via `exp(totalLogReturn) - 1`.
 */
import type {
  AttributionDayPointLog,
  FactorCode,
  PeriodAttributionSummaryLog,
} from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";
import { expSumMinus1 } from "./log-returns";

type PeriodLabel = "1D" | "5D" | "MTD" | "QTD" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ITD";

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

export function computePeriodLogAttribution(
  daily: AttributionDayPointLog[],
  factorCodes: FactorCode[],
  refDate?: Date,
): PeriodAttributionSummaryLog[] {
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

  const PERIODS: PeriodLabel[] = [
    "1D",
    "5D",
    "MTD",
    "QTD",
    "1M",
    "3M",
    "6M",
    "YTD",
    "1Y",
    "ITD",
  ];

  return PERIODS.map((label) => {
    const start = periodStart(label);
    const slice = daily.filter((d) => d.date >= start);

    let totalLogReturn = 0;
    let factorLogReturn = 0;
    let rfLogReturn = 0;
    let alpha = 0;
    const byFactorSum: Record<string, number> = {};

    for (const d of slice) {
      totalLogReturn += d.portExcessLogReturn;
      factorLogReturn += Object.values(d.byFactor).reduce((s, v) => s + v, 0);
      rfLogReturn += d.rfLogContrib;
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
        pct: Math.abs(totalLogReturn) > 1e-10 ? contribution / Math.abs(totalLogReturn) : 0,
      };
    });

    return {
      label,
      startDate: start,
      endDate: lastDate,
      totalLogReturn,
      totalGeometricReturn: expSumMinus1(totalLogReturn),
      factorLogReturn,
      rfLogReturn,
      alpha,
      byFactor,
    };
  });
}
