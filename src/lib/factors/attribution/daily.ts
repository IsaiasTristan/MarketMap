/**
 * Daily factor return attribution using rolling joint betas.
 *
 * For each day t (after the first window of rolling fits), the portfolio
 * total return is decomposed as:
 *
 *   r_p,t  ≈  RF_t  +  Σ_f β_f,t × f_t  +  α_t
 *
 * where:
 *   - RF_t     = daily risk-free rate (from FactorReturnDaily)
 *   - β_f,t    = factor loading estimated from rolling regression ending at t
 *   - f_t      = factor excess return on day t (MKT_RF, SMB, ...)
 *   - α_t      = residual / unexplained return
 *
 * We use the rolling fit whose window ENDS at t (i.e. in-sample fit), which
 * is appropriate for historical attribution. For forward-looking exposure
 * estimates the end-of-period fit should be used instead.
 */
import type { AttributionDayPoint, RollingFitPoint } from "@/types/factors";
import type { FactorCode } from "@/types/factors";

/**
 * Compute daily attribution points aligned to the rolling fits.
 *
 * @param rollingFits   Rolling OLS fits (one per date, starting at window-1).
 * @param factorCodes   Factor codes in the same order as `fit.betas`.
 * @param factorReturns Map from date → per-factor return; key = FactorCode.
 * @param portTotalReturns Map from date → portfolio total return (not excess).
 * @param rfReturns     Map from date → daily RF rate.
 */
export function computeDailyAttribution(
  rollingFits: RollingFitPoint[],
  factorCodes: FactorCode[],
  factorReturns: Map<string, Record<string, number>>,
  portTotalReturns: Map<string, number>,
  rfReturns: Map<string, number>,
): AttributionDayPoint[] {
  const out: AttributionDayPoint[] = [];

  for (const { date, fit } of rollingFits) {
    const portTotal = portTotalReturns.get(date);
    const rf = rfReturns.get(date) ?? 0;
    if (portTotal === undefined) continue;

    const dayFactors = factorReturns.get(date) ?? {};
    const byFactor: Record<string, number> = {};
    let totalFactorReturn = 0;

    for (let fi = 0; fi < factorCodes.length; fi++) {
      const code = factorCodes[fi]!;
      const beta = fit.betas[fi] ?? 0;
      const factorRet = dayFactors[code] ?? 0;
      const contrib = beta * factorRet;
      byFactor[code] = contrib;
      totalFactorReturn += contrib;
    }

    const portExcess = portTotal - rf;
    const alpha = portExcess - totalFactorReturn;

    out.push({
      date,
      portExcessReturn: portExcess,
      rfContrib: rf,
      byFactor: byFactor as Record<FactorCode, number>,
      alpha,
    });
  }

  return out;
}

/**
 * Daily factor attribution using a SINGLE fixed beta vector (the horizon
 * end-fit) applied to every date, rather than a per-day rolling fit.
 *
 *   r_p,t  ≈  RF_t  +  Σ_f β_f × f_t  +  α_t
 *
 * where β_f is the same end-of-window regression loading for all t and α_t is
 * the realized-minus-systematic plug (so the headline total stays the realized
 * return regardless of the beta convention).
 *
 * Unlike {@link computeDailyAttribution} this is defined for EVERY aligned date
 * (not gated by the rolling burn-in), so trailing reporting periods (1D…1Y) can
 * always be sliced even when the horizon window consumes most of the history.
 * This mirrors the per-stock period approach (snapshot β × cumulative factor
 * return over the slice).
 *
 * @param dates            Aligned date strings (length n).
 * @param betas            Fixed factor loadings, one per `factorCodes` entry.
 * @param factorCodes      Factor codes in the same order as `betas`.
 * @param factorReturns    Map from date → per-factor return; key = FactorCode.
 * @param portTotalReturns Map from date → portfolio total return (not excess).
 * @param rfReturns        Map from date → daily RF rate.
 */
export function computeStaticBetaDailyAttribution(
  dates: string[],
  betas: number[],
  factorCodes: FactorCode[],
  factorReturns: Map<string, Record<string, number>>,
  portTotalReturns: Map<string, number>,
  rfReturns: Map<string, number>,
): AttributionDayPoint[] {
  const out: AttributionDayPoint[] = [];

  for (const date of dates) {
    const portTotal = portTotalReturns.get(date);
    if (portTotal === undefined) continue;
    const rf = rfReturns.get(date) ?? 0;

    const dayFactors = factorReturns.get(date) ?? {};
    const byFactor: Record<string, number> = {};
    let totalFactorReturn = 0;

    for (let fi = 0; fi < factorCodes.length; fi++) {
      const code = factorCodes[fi]!;
      const beta = betas[fi] ?? 0;
      const factorRet = dayFactors[code] ?? 0;
      const contrib = beta * factorRet;
      byFactor[code] = contrib;
      totalFactorReturn += contrib;
    }

    const portExcess = portTotal - rf;
    const alpha = portExcess - totalFactorReturn;

    out.push({
      date,
      portExcessReturn: portExcess,
      rfContrib: rf,
      byFactor: byFactor as Record<FactorCode, number>,
      alpha,
    });
  }

  return out;
}
