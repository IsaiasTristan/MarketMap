/**
 * Box 6 — Balance-Sheet Strength. Pure math, no I/O. Can shareholders benefit
 * from the operating inflection without excessive insolvency / refinancing /
 * liquidity risk? Components oriented HIGHER = BETTER:
 *  - netLeverageQuality = -(net debt / EBITDA)   (lower leverage better)
 *  - interestCoverage    = TTM EBITDA / TTM interest expense (capped)
 *  - cashRunway          = (cash + max(TTM FCF, 0)) / total debt (capped)
 *
 * Capping keeps "no debt / no interest" names (genuinely strong) finite so the
 * cross-sectional z-score is not blown out by an infinity.
 */

/** Caps so debt-free / interest-free names stay finite but clearly strong. */
export const COVERAGE_CAP = 50;
export const RUNWAY_CAP = 50;
const INTEREST_FLOOR = 1e-6;
const DEBT_FLOOR = 1e-6;

export interface BalanceSheetInputs {
  /** Net debt / EBITDA (current, TTM-EBITDA basis). */
  netDebtToEbitda: number | null;
  /** TTM EBITDA (our derived). */
  ebitdaTtm: number | null;
  /** TTM interest expense (>= 0 magnitude; FMP reports a positive expense). */
  interestExpenseTtm: number | null;
  /** Cash & equivalents (latest). */
  cash: number | null;
  /** TTM free cash flow. */
  fcfTtm: number | null;
  /** Total debt (latest). */
  totalDebt: number | null;
}

export const BALANCE_SHEET_COMPONENT_KEYS = [
  "netLeverageQuality",
  "interestCoverage",
  "cashRunway",
] as const;

export type BalanceSheetComponents = Record<
  (typeof BALANCE_SHEET_COMPONENT_KEYS)[number],
  number | null
>;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function interestCoverage(ebitda: number | null, interest: number | null): number | null {
  if (ebitda === null) return null;
  const mag = interest === null ? 0 : Math.abs(interest);
  if (mag < INTEREST_FLOOR) {
    // No interest burden: strong if EBITDA positive, undefined if EBITDA <= 0.
    return ebitda > 0 ? COVERAGE_CAP : null;
  }
  return clamp(ebitda / mag, -COVERAGE_CAP, COVERAGE_CAP);
}

function cashRunway(cash: number | null, fcf: number | null, debt: number | null): number | null {
  if (cash === null) return null;
  const cushion = cash + Math.max(fcf ?? 0, 0);
  const d = debt === null ? 0 : Math.abs(debt);
  if (d < DEBT_FLOOR) return cushion > 0 ? RUNWAY_CAP : 0; // debt-free = maximal runway
  return clamp(cushion / d, 0, RUNWAY_CAP);
}

/** Compute the balance-sheet components (already oriented higher = better). */
export function balanceSheetComponents(inputs: BalanceSheetInputs): BalanceSheetComponents {
  const lev =
    inputs.netDebtToEbitda !== null && Number.isFinite(inputs.netDebtToEbitda)
      ? -inputs.netDebtToEbitda
      : null;
  return {
    netLeverageQuality: lev,
    interestCoverage: interestCoverage(inputs.ebitdaTtm, inputs.interestExpenseTtm),
    cashRunway: cashRunway(inputs.cash, inputs.fcfTtm, inputs.totalDebt),
  };
}
