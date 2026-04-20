/**
 * Factor shock / stress scenario calculations.
 *
 * Applies instantaneous factor shocks to portfolio factor betas to estimate
 * the expected P&L impact:
 *
 *   ΔP ≈ Σ_f β_f × Δf
 *
 * This is a first-order linear approximation — appropriate for small to
 * moderate shocks. Non-linear effects (e.g. from convexity) are not captured.
 */
import type {
  FactorCode,
  FactorShock,
  ScenarioDefinition,
  ScenarioResult,
  ScenarioPositionImpact,
  PositionLoadings,
} from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

/**
 * Apply a set of factor shocks to a portfolio's factor exposure vector.
 *
 * @param portfolioBetas  Portfolio-level betas (same order as factorCodes).
 * @param factorCodes     Factor codes in order.
 * @param scenario        Scenario definition (contains the shocks).
 * @param positionLoadings Per-position loadings for position-level P&L. Optional.
 * @returns               ScenarioResult with estimated P&L and breakdown.
 */
export function applyFactorShock(
  portfolioBetas: number[],
  factorCodes: FactorCode[],
  scenario: ScenarioDefinition,
  positionLoadings?: PositionLoadings[],
): ScenarioResult {
  const asOfDate = new Date().toISOString().slice(0, 10);

  const shockMap = new Map(scenario.shocks.map((s) => [s.code, s.shockValue]));

  // Portfolio-level impact per factor
  let estimatedPortPnl = 0;
  const byFactor = factorCodes.map((code, i) => {
    const beta = portfolioBetas[i] ?? 0;
    const shockValue = shockMap.get(code) ?? 0;
    const contribution = beta * shockValue;
    estimatedPortPnl += contribution;
    return {
      code,
      label: getFactorDef(code).label,
      shockValue,
      contribution,
    };
  });

  // Position-level impacts (if holdings loadings available)
  const byPosition: ScenarioPositionImpact[] = (positionLoadings ?? []).map((pos) => {
    let impact = 0;
    for (const code of factorCodes) {
      const loading = pos.loadings[code] ?? 0;
      const shock = shockMap.get(code) ?? 0;
      impact += loading * shock;
    }
    return {
      ticker: pos.ticker,
      weight: pos.weight,
      estimatedPnl: pos.weight * impact,
    };
  });

  return {
    scenario,
    estimatedPortPnl,
    byFactor,
    byPosition,
    asOfDate,
  };
}
