/**
 * Box 4 — Cash Conversion & Accrual Quality. Pure math, no I/O. Distinguishes
 * genuine cash-backed operating improvement from accounting earnings, temporary
 * working-capital releases, or deferred capex. Components oriented HIGHER =
 * BETTER:
 *  - fcfConversion = (CFO + capex) / EBITDA  (capex is FMP-negative, so this is
 *    free cash flow / EBITDA); only meaningful when EBITDA > 0.
 *  - accrualQuality = -(NI - CFO) / avgAssets  (Sloan accruals, inverted: low
 *    accruals are higher quality).
 *  - workingCapitalQuality = -(ΔWC cash effect / |CFO|)  (a large working-capital
 *    RELEASE inflating CFO is penalised).
 */
import { accrualsRatio } from "./quality";

export interface CashQualityInputs {
  /** TTM operating cash flow. */
  cfoTtm: number | null;
  /** TTM capital expenditure (FMP convention: negative = spend). */
  capexTtm: number | null;
  /** TTM EBITDA (our derived = operating income + D&A). */
  ebitdaTtm: number | null;
  /** TTM net income. */
  netIncomeTtm: number | null;
  /** Average total assets across the TTM window. */
  avgTotalAssets: number | null;
  /** TTM cash-flow effect of working-capital changes (FMP: positive = source). */
  changeInWorkingCapitalTtm: number | null;
}

export const CASH_QUALITY_COMPONENT_KEYS = [
  "fcfConversion",
  "accrualQuality",
  "workingCapitalQuality",
] as const;

export type CashQualityComponents = Record<
  (typeof CASH_QUALITY_COMPONENT_KEYS)[number],
  number | null
>;

function fcfConversion(cfo: number | null, capex: number | null, ebitda: number | null): number | null {
  if (cfo === null || capex === null || ebitda === null) return null;
  if (!(ebitda > 0)) return null; // ratio meaningless / sign-flipping when EBITDA <= 0
  const fcf = cfo + capex; // capex negative in FMP
  return fcf / ebitda;
}

function workingCapitalQuality(deltaWc: number | null, cfo: number | null): number | null {
  if (deltaWc === null || cfo === null) return null;
  const denom = Math.abs(cfo);
  if (denom < 1e-6) return null;
  // Positive ΔWC = cash released into CFO (lower quality) -> negative component.
  return -(deltaWc / denom);
}

/** Compute the cash-quality components (already oriented higher = better). */
export function cashQualityComponents(inputs: CashQualityInputs): CashQualityComponents {
  const accr = accrualsRatio(inputs.netIncomeTtm, inputs.cfoTtm, inputs.avgTotalAssets);
  return {
    fcfConversion: fcfConversion(inputs.cfoTtm, inputs.capexTtm, inputs.ebitdaTtm),
    accrualQuality: accr === null ? null : -accr,
    workingCapitalQuality: workingCapitalQuality(inputs.changeInWorkingCapitalTtm, inputs.cfoTtm),
  };
}
