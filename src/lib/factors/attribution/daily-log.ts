/**
 * Daily log-return factor attribution (Path B).
 *
 * For each day t (post burn-in) the portfolio excess log return is
 * decomposed in log space:
 *
 *   y_log,t  =  α_log,t  +  Σ_f β_f,t · x_log,f,t  +  ε_log,t
 *
 * Multi-period sums of `y_log` equal `ln(Π(1 + r_simple_excess_t))`, so
 * `exp(Σ y_log) - 1` reconciles exactly to the compounded geometric
 * realised excess. The simple-return identity in `daily.ts` is preserved
 * in parallel for legacy consumers.
 */
import type {
  AttributionDayPointLog,
  FactorCode,
  RollingFitPoint,
} from "@/types/factors";

export function computeDailyLogAttribution(
  rollingFits: RollingFitPoint[],
  factorCodes: FactorCode[],
  factorLogReturns: Map<string, Record<string, number>>,
  portExcessLogReturns: Map<string, number>,
  rfLogReturns: Map<string, number>,
): AttributionDayPointLog[] {
  const out: AttributionDayPointLog[] = [];

  for (const { date, fit } of rollingFits) {
    const yLog = portExcessLogReturns.get(date);
    const rfLog = rfLogReturns.get(date) ?? 0;
    if (yLog === undefined) continue;
    if (fit.failed) continue;

    const dayFactors = factorLogReturns.get(date) ?? {};
    const byFactor: Record<string, number> = {};
    let totalFactorLog = 0;

    for (let fi = 0; fi < factorCodes.length; fi++) {
      const code = factorCodes[fi]!;
      const beta = fit.betas[fi] ?? 0;
      const xLog = dayFactors[code] ?? 0;
      const contrib = beta * xLog;
      byFactor[code] = contrib;
      totalFactorLog += contrib;
    }

    const alpha = yLog - totalFactorLog;

    out.push({
      date,
      portExcessLogReturn: yLog,
      rfLogContrib: rfLog,
      byFactor: byFactor as Record<FactorCode, number>,
      alpha,
    });
  }

  return out;
}

/**
 * Log-space daily attribution using a SINGLE fixed beta vector (the horizon
 * end-fit, log space). Full-length analogue of {@link computeDailyLogAttribution}
 * — defined for every aligned date so trailing periods can always be sliced.
 *
 *   y_log,t  =  α_log,t  +  Σ_f β_f · x_log,f,t
 *
 * where β_f is the same end-of-window log loading for all t and α_log,t is the
 * realized-minus-systematic plug. Multi-period sums of `y_log` reconcile to
 * compounded geometric realised excess via `exp(Σ y_log) − 1`.
 */
export function computeStaticBetaDailyLogAttribution(
  dates: string[],
  betas: number[],
  factorCodes: FactorCode[],
  factorLogReturns: Map<string, Record<string, number>>,
  portExcessLogReturns: Map<string, number>,
  rfLogReturns: Map<string, number>,
): AttributionDayPointLog[] {
  const out: AttributionDayPointLog[] = [];

  for (const date of dates) {
    const yLog = portExcessLogReturns.get(date);
    if (yLog === undefined) continue;
    const rfLog = rfLogReturns.get(date) ?? 0;

    const dayFactors = factorLogReturns.get(date) ?? {};
    const byFactor: Record<string, number> = {};
    let totalFactorLog = 0;

    for (let fi = 0; fi < factorCodes.length; fi++) {
      const code = factorCodes[fi]!;
      const beta = betas[fi] ?? 0;
      const xLog = dayFactors[code] ?? 0;
      const contrib = beta * xLog;
      byFactor[code] = contrib;
      totalFactorLog += contrib;
    }

    const alpha = yLog - totalFactorLog;

    out.push({
      date,
      portExcessLogReturn: yLog,
      rfLogContrib: rfLog,
      byFactor: byFactor as Record<FactorCode, number>,
      alpha,
    });
  }

  return out;
}
