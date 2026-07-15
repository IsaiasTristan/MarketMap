import type { CurvePoint, TenorColumn } from "@/types/commodities";
import { rollingStrip } from "./strips";

/**
 * Fixed tenor grid for the vintage-delta table: seven point tenors (indexes
 * into the strip) followed by three rolling strip averages. Point tenors are
 * positional — "1Y" is the 12th contract on the strip (index 11), whatever
 * calendar month that lands on — and the UI renders the resolved contract
 * month, never M1/M6 notation. Strips beyond their length yield nulls; no
 * length is ever assumed.
 */

export const TENOR_DEFS: {
  label: "1M" | "3M" | "6M" | "1Y" | "2Y" | "3Y" | "5Y";
  index: number;
}[] = [
  { label: "1M", index: 0 },
  { label: "3M", index: 2 },
  { label: "6M", index: 5 },
  { label: "1Y", index: 11 },
  { label: "2Y", index: 23 },
  { label: "3Y", index: 35 },
  { label: "5Y", index: 59 },
];

const ROLLING_STRIP_DEFS: { label: string; months: 12 | 36 | 60 }[] = [
  { label: "12M AVG", months: 12 },
  { label: "36M AVG", months: 36 },
  { label: "60M AVG", months: 60 },
];

/**
 * Column headers resolved against the latest strip: the 7 point tenors carry
 * the contract month at their index (null when the strip is shorter), the
 * 3 strip columns carry no single contract month.
 */
export function tenorColumns(latestPoints: CurvePoint[]): TenorColumn[] {
  return [
    ...TENOR_DEFS.map((d) => ({
      label: d.label,
      contractMonth: latestPoints[d.index]?.contractMonth ?? null,
    })),
    ...ROLLING_STRIP_DEFS.map((d) => ({ label: d.label, contractMonth: null })),
  ];
}

/**
 * One row of tenor values for any strip (latest or a vintage): the 7 point
 * prices (null when the index is beyond the strip) followed by the three
 * rolling strip averages. Aligned 1:1 with `tenorColumns`.
 */
export function tenorValues(points: CurvePoint[]): (number | null)[] {
  return [
    ...TENOR_DEFS.map((d) => points[d.index]?.price ?? null),
    ...ROLLING_STRIP_DEFS.map((d) => rollingStrip(points, d.months).avg),
  ];
}
