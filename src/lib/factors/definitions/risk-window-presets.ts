/**
 * Risk-tab window presets — trailing windows (in trading days) over which the
 * Euler variance decomposition is re-estimated. Decoupled from HORIZON
 * (`FactorWindow`) so a user can ask "what does my risk look like over the
 * last 1M / 6M / 1Y / 2Y / 5Y?" without disturbing exposure/attribution
 * betas, which are fit on the HORIZON sample.
 *
 * Used by:
 *   - RiskPanel (segmented control above the variance decomposition)
 *   - FactorsClient (window param sent to /api/analysis/factors/risk)
 *
 * Values must stay in sync with `FactorRiskWindow` in the analysis store.
 */
import type { FactorRiskWindow } from "@/store/analysis";

export interface RiskWindowPreset {
  value: FactorRiskWindow;
  label: string;
  sub: string;
}

export const RISK_WINDOW_PRESETS: RiskWindowPreset[] = [
  { value: 21, label: "1M", sub: "1 month" },
  { value: 126, label: "6M", sub: "6 months" },
  { value: 252, label: "1Y", sub: "1 year" },
  { value: 504, label: "2Y", sub: "2 years" },
  { value: 1260, label: "5Y", sub: "5 years" },
];

export function getRiskWindowPreset(value: FactorRiskWindow): RiskWindowPreset {
  return RISK_WINDOW_PRESETS.find((p) => p.value === value) ?? RISK_WINDOW_PRESETS[2]!;
}
