/**
 * Box 7 — Valuation. Pure math, no I/O. Cross-sectional cheapness vs subsector
 * peers (distinct from the intra-ticker own-history `cheapness` percentile,
 * which is kept). Components oriented HIGHER = BETTER (cheaper / higher yield):
 *  - evEbitdaValue = -(EV / EBITDA)   (only when positive)
 *  - peValue       = -(P / E)         (only when positive)
 *  - fcfYieldValue = FCF yield        (higher better; may be negative)
 *  - divYieldValue = dividend yield   (higher better; >= 0)
 *
 * Negative EV/EBITDA or P/E carry no cheapness meaning, so they are dropped
 * (null) rather than scored as "extremely cheap".
 */

export interface ValuationBoxInputs {
  evToEbitda: number | null;
  peRatio: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
}

export const VALUATION_BOX_COMPONENT_KEYS = [
  "evEbitdaValue",
  "peValue",
  "fcfYieldValue",
  "divYieldValue",
] as const;

export type ValuationBoxComponents = Record<
  (typeof VALUATION_BOX_COMPONENT_KEYS)[number],
  number | null
>;

function invIfPositive(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? -v : null;
}

/** Compute the valuation-box components (already oriented higher = better). */
export function valuationBoxComponents(inputs: ValuationBoxInputs): ValuationBoxComponents {
  return {
    evEbitdaValue: invIfPositive(inputs.evToEbitda),
    peValue: invIfPositive(inputs.peRatio),
    fcfYieldValue:
      inputs.fcfYield !== null && Number.isFinite(inputs.fcfYield) ? inputs.fcfYield : null,
    divYieldValue:
      inputs.dividendYield !== null && Number.isFinite(inputs.dividendYield)
        ? inputs.dividendYield
        : null,
  };
}
