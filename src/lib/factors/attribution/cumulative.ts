/**
 * Cumulative factor attribution — compound daily contributions.
 *
 * Compounding method: additive (sum of daily) is used for display clarity.
 * Geometric compounding is available but causes visual confusion when factor
 * contributions are small daily values. Institutions typically show additive
 * cumulative attribution for factor analysis.
 */
import type { AttributionDayPoint, CumulativeAttributionPoint } from "@/types/factors";

export function computeCumulativeAttribution(
  daily: AttributionDayPoint[],
): CumulativeAttributionPoint[] {
  let cumPort = 0;
  let cumAlpha = 0;
  let cumRf = 0;
  const cumByFactor: Record<string, number> = {};

  return daily.map((d) => {
    cumPort += d.portExcessReturn;
    cumAlpha += d.alpha;
    cumRf += d.rfContrib;

    for (const [code, contrib] of Object.entries(d.byFactor)) {
      cumByFactor[code] = (cumByFactor[code] ?? 0) + contrib;
    }

    return {
      date: d.date,
      cumulativePortReturn: cumPort,
      cumulativeAlpha: cumAlpha,
      cumulativeRf: cumRf,
      byFactor: { ...cumByFactor },
    };
  });
}
