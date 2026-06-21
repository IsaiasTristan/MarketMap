/**
 * pickPeriodRiskSummary — period-sliced realised variance decomposition
 * for the portfolio Variance waterfall.
 *
 * The portfolio Total Return waterfall already slices to the selected
 * Attribution Period via {@link pickPeriodSummary} (which reads the
 * pre-bucketed `attribution.periods` / `periodsLog`). The companion Variance
 * waterfall historically read whole-window Euler (`β'Σβ + σ²_idio`) model
 * shares, so changing the period had no effect on it.
 *
 * This helper computes a realised variance decomposition on the same daily
 * slice the return waterfall uses:
 *
 *   Var_total = Σ ( contrib_f,t )²  +  Σ alpha_t²
 *               └────── factor SS ─────┘  └ residual SS ┘
 *
 * Factor share = Σ contrib_f,t² / Var_total. Idio share = Σ α_t² / Var_total.
 * Shares sum to 100 % by construction. Headline is the annualised realised σ
 * of `portExcessReturn` on the same slice.
 *
 * Anchoring to **sum-of-squares** (not covariance) keeps the decomposition
 * additive on tiny slices like 5D where a covariance matrix would be ill-
 * conditioned, and matches the standard "realised variance" treatment used
 * in higher-frequency factor attribution.
 */
import type { AttributionResult, FactorCode } from "@/types/factors";
import type { FactorPeriod } from "@/store/analysis";
import { getFactorDef } from "../definitions/factor-codes";
import { resolvePeriodSlice } from "./period";

export interface PickedPeriodRisk {
  label: FactorPeriod;
  startDate: string;
  endDate: string;
  /** Number of daily observations in the slice. */
  observations: number;
  /** Annualised realised σ of portfolio excess return over the slice. */
  realizedAnnualizedVol: number;
  /** Σ α_t² / Var_total — idiosyncratic share. */
  idioShare: number;
  /** 1 − idioShare — explained-by-factors share. */
  systematicShare: number;
  /** Per-factor variance share (Σ contrib_f,t² / Var_total). */
  byFactor: { code: FactorCode; label: string; share: number }[];
}

const TRADING_DAYS_PER_YEAR = 252;

export function pickPeriodRiskSummary(
  attribution: AttributionResult | null | undefined,
  period: FactorPeriod,
  factorCodes: FactorCode[],
): PickedPeriodRisk | null {
  if (!attribution || !attribution.daily.length) return null;

  const dates = attribution.daily.map((d) => d.date);
  const slice = resolvePeriodSlice(dates, period);
  if (slice.startIndex < 0) return null;

  const points = attribution.daily.slice(slice.startIndex, slice.endIndex + 1);
  if (points.length < 2) return null;

  // Realised vol on the slice (sample variance × 252 → annualised σ).
  const yMean =
    points.reduce((s, p) => s + p.portExcessReturn, 0) / points.length;
  const sampleVar =
    points.reduce((s, p) => s + (p.portExcessReturn - yMean) ** 2, 0) /
    (points.length - 1);
  const realizedAnnualizedVol = Math.sqrt(sampleVar * TRADING_DAYS_PER_YEAR);

  // Sum-of-squares decomposition. Use absolute SS (centred only for the
  // headline) — factor contributions are already mean-zero in expectation
  // and a non-zero mean is part of the realised variance signal we want
  // to attribute. (Centering each factor SS independently would double-
  // count the cross-mean term.)
  let totalSS = 0;
  const factorSS: Record<string, number> = {};
  for (const code of factorCodes) factorSS[code] = 0;
  let idioSS = 0;
  for (const p of points) {
    for (const code of factorCodes) {
      const c = (p.byFactor as Record<string, number>)[code] ?? 0;
      factorSS[code] = (factorSS[code] ?? 0) + c * c;
      totalSS += c * c;
    }
    idioSS += p.alpha * p.alpha;
    totalSS += p.alpha * p.alpha;
  }

  const byFactor = factorCodes.map((code) => {
    const ss = factorSS[code] ?? 0;
    return {
      code,
      label: getFactorDef(code).label,
      share: totalSS > 0 ? ss / totalSS : 0,
    };
  });

  return {
    label: period,
    startDate: slice.startDate,
    endDate: slice.endDate,
    observations: points.length,
    realizedAnnualizedVol,
    idioShare: totalSS > 0 ? idioSS / totalSS : 0,
    systematicShare: totalSS > 0 ? 1 - idioSS / totalSS : 0,
    byFactor,
  };
}
