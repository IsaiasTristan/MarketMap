import type { CurvePoint, SeasonalityDto, SeasonalityRow } from "@/types/commodities";
import { monthKeyFromIso } from "./format";

/**
 * Gas seasonality: winter (Nov Y – Mar Y+1) and summer (Apr Y – Oct Y) strip
 * averages off the latest curve, with a 1M-vintage delta per season. Emits
 * four rows — the first winter starting at/after the strip's front month,
 * then summer/winter/summer alternating forward. Season averages use the
 * months actually present in each strip (gaps tolerated); null when a season
 * has no months on the curve. Pure.
 */

function yy(year: number): string {
  return String(year % 100).padStart(2, "0");
}

/** Winter season anchored at year Y: Nov Y, Dec Y, Jan..Mar of Y+1. */
function winterMonths(year: number): string[] {
  return [
    `${year}-11`,
    `${year}-12`,
    `${year + 1}-01`,
    `${year + 1}-02`,
    `${year + 1}-03`,
  ];
}

/** Summer season of year Y: Apr..Oct of Y. */
function summerMonths(year: number): string[] {
  const out: string[] = [];
  for (let m = 4; m <= 10; m++) out.push(`${year}-${String(m).padStart(2, "0")}`);
  return out;
}

function seasonAvg(byMonth: Map<string, number>, months: string[]): number | null {
  let total = 0;
  let n = 0;
  for (const m of months) {
    const v = byMonth.get(m);
    if (v === undefined) continue;
    total += v;
    n++;
  }
  return n === 0 ? null : total / n;
}

export function gasSeasonality(
  latest: CurvePoint[],
  vintage1M: CurvePoint[] | null,
  settleDateIso: string,
): SeasonalityDto {
  const latestByMonth = new Map<string, number>();
  for (const p of latest) latestByMonth.set(p.contractMonth, p.price);
  const vintageByMonth = vintage1M
    ? new Map<string, number>(vintage1M.map((p) => [p.contractMonth, p.price]))
    : null;

  // First winter whose start (Nov Y) is at/after the strip's front month.
  const startKey = latest[0]?.contractMonth ?? monthKeyFromIso(settleDateIso);
  let winterYear = Number(startKey.slice(0, 4));
  if (`${winterYear}-11` < startKey) winterYear += 1;

  const seasons: { label: string; months: string[] }[] = [
    { label: `WIN ${yy(winterYear)}/${yy(winterYear + 1)}`, months: winterMonths(winterYear) },
    { label: `SUM ${yy(winterYear + 1)}`, months: summerMonths(winterYear + 1) },
    { label: `WIN ${yy(winterYear + 1)}/${yy(winterYear + 2)}`, months: winterMonths(winterYear + 1) },
    { label: `SUM ${yy(winterYear + 2)}`, months: summerMonths(winterYear + 2) },
  ];

  const rows: SeasonalityRow[] = seasons.map(({ label, months }) => {
    const price = seasonAvg(latestByMonth, months);
    const priorPrice = vintageByMonth ? seasonAvg(vintageByMonth, months) : null;
    const delta1M = price !== null && priorPrice !== null ? price - priorPrice : null;
    return { label, price, delta1M };
  });

  const firstWin = rows[0]?.price ?? null;
  const firstSum = rows[1]?.price ?? null;
  const winterSummerSpread =
    firstWin !== null && firstSum !== null ? firstWin - firstSum : null;

  return { rows, winterSummerSpread };
}
