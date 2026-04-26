/**
 * Cumulative log-return attribution (Path B).
 *
 * Σ daily log values is the additive identity that reconciles to the
 * compounded geometric return via `exp(.) - 1`. Per-factor cumulative log
 * sums DO NOT individually exponentiate-and-sum to the total geometric
 * realised — only the log identity is additive. The UI surfaces a footnote
 * that warns against double-counting `exp(component) - 1` bars.
 */
import type {
  AttributionDayPointLog,
  CumulativeAttributionPointLog,
} from "@/types/factors";
import { expSumMinus1 } from "./log-returns";

export function computeCumulativeLogAttribution(
  daily: AttributionDayPointLog[],
): CumulativeAttributionPointLog[] {
  let cumPortLog = 0;
  let cumAlpha = 0;
  let cumRf = 0;
  const cumByFactor: Record<string, number> = {};

  return daily.map((d) => {
    cumPortLog += d.portExcessLogReturn;
    cumAlpha += d.alpha;
    cumRf += d.rfLogContrib;

    for (const [code, contrib] of Object.entries(d.byFactor)) {
      cumByFactor[code] = (cumByFactor[code] ?? 0) + contrib;
    }

    return {
      date: d.date,
      cumulativePortLogReturn: cumPortLog,
      cumulativePortGeometric: expSumMinus1(cumPortLog),
      cumulativeAlpha: cumAlpha,
      cumulativeRf: cumRf,
      byFactor: { ...cumByFactor },
    };
  });
}
