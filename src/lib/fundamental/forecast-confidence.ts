/**
 * Box 10 — Forecast Confidence. Pure math, no I/O. Are consensus estimates
 * coherent, well-supported, and becoming more certain? Built primarily on
 * analyst-estimate dispersion (inverted + coverage-adjusted), so the box is
 * named "Forecast Confidence", not "Dispersion". Components oriented HIGHER =
 * BETTER:
 *  - epsDispQuality / revDispQuality / ebitdaDispQuality = -dispersion (require >=3 analysts)
 *  - dispChangeQuality = -(currentEpsDisp - priorEpsDisp)  (declining dispersion better)
 *  - analystCoverage   = analyst count (more coverage better)
 *  - consensusStability = -stdev(last EPS surprises)  (stable, predictable reports)
 *
 * A single analyst reporting zero dispersion must NOT read as high confidence,
 * so dispersion components require at least MIN_ANALYSTS_DISPERSION analysts.
 */
import { stdev } from "./inflection";

export const DISPERSION_DENOM_FLOOR = 1e-6;
export const MIN_ANALYSTS_DISPERSION = 3;

export interface EstimateTriple {
  low: number | null;
  avg: number | null;
  high: number | null;
}

/** Dispersion = (high - low) / max(|avg|, floor). Null if the triple is incomplete. */
export function dispersion(t: EstimateTriple | null, floor = DISPERSION_DENOM_FLOOR): number | null {
  if (!t) return null;
  const { low, avg, high } = t;
  if (low === null || avg === null || high === null) return null;
  if (!Number.isFinite(low) || !Number.isFinite(avg) || !Number.isFinite(high)) return null;
  const denom = Math.max(Math.abs(avg), floor);
  if (denom < 1e-12) return null;
  return (high - low) / denom;
}

export interface ForecastConfidenceInputs {
  eps: EstimateTriple | null;
  revenue: EstimateTriple | null;
  ebitda: EstimateTriple | null;
  priorEpsDispersion: number | null;
  numAnalystsEps: number | null;
  numAnalystsRevenue: number | null;
  /** Trailing EPS surprise ratios (oldest -> newest) for the stability read. */
  epsSurpriseHistory: number[];
}

export const FORECAST_CONFIDENCE_COMPONENT_KEYS = [
  "epsDispQuality",
  "revDispQuality",
  "ebitdaDispQuality",
  "dispChangeQuality",
  "analystCoverage",
  "consensusStability",
] as const;

export type ForecastConfidenceComponents = Record<
  (typeof FORECAST_CONFIDENCE_COMPONENT_KEYS)[number],
  number | null
>;

function negOrNull(v: number | null): number | null {
  return v === null ? null : -v;
}

/** Compute the forecast-confidence components (already oriented higher = better). */
export function forecastConfidenceComponents(
  inputs: ForecastConfidenceInputs,
): ForecastConfidenceComponents {
  const epsCount = inputs.numAnalystsEps ?? 0;
  const revCount = inputs.numAnalystsRevenue ?? 0;
  const epsOk = epsCount >= MIN_ANALYSTS_DISPERSION;
  const revOk = revCount >= MIN_ANALYSTS_DISPERSION;

  const epsDisp = epsOk ? dispersion(inputs.eps) : null;
  const revDisp = revOk ? dispersion(inputs.revenue) : null;
  // EBITDA has no dedicated analyst count — gate on EPS coverage as a proxy.
  const ebitdaDisp = epsOk ? dispersion(inputs.ebitda) : null;

  const dispChange =
    epsDisp !== null && inputs.priorEpsDispersion !== null
      ? epsDisp - inputs.priorEpsDispersion
      : null;

  const stability = inputs.epsSurpriseHistory.length >= MIN_ANALYSTS_DISPERSION
    ? negOrNull(stdev(inputs.epsSurpriseHistory))
    : null;

  const coverage = epsCount > 0 || revCount > 0 ? Math.max(epsCount, revCount) : null;

  return {
    epsDispQuality: negOrNull(epsDisp),
    revDispQuality: negOrNull(revDisp),
    ebitdaDispQuality: negOrNull(ebitdaDisp),
    dispChangeQuality: negOrNull(dispChange),
    analystCoverage: coverage,
    consensusStability: stability,
  };
}
