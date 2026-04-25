/**
 * factor-scenarios.service — factor stress scenario execution.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import { applyFactorShock } from "@/lib/factors/scenarios/shocks";
import {
  SYNTHETIC_SCENARIOS,
  HISTORICAL_SCENARIO_KEYS,
} from "@/lib/factors/scenarios/historical-scenarios";
import { computeSensitivityTable } from "@/lib/factors/scenarios/sensitivity";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import type {
  ScenarioDefinition,
  ScenarioResult,
  SensitivityEntry,
  FactorCode,
  ModelPresetName,
} from "@/types/factors";
import { runFactorEngine } from "./factor-engine.service";

/** List all available scenarios (synthetic + historical stubs). */
export function listScenarios(): ScenarioDefinition[] {
  const historical: ScenarioDefinition[] = HISTORICAL_SCENARIO_KEYS.map((h) => ({
    key: h.key,
    label: h.label,
    description: h.description,
    shocks: [], // populated by computeHistoricalShocks below
    isHistorical: true,
    historicalWindow: h.historicalWindow,
  }));
  return [...SYNTHETIC_SCENARIOS, ...historical];
}

/** Compute realized factor returns for a historical window from FactorReturnDaily. */
async function computeHistoricalShocks(
  factorCodes: FactorCode[],
  start: string,
  end: string,
): Promise<{ code: FactorCode; shockValue: number }[]> {
  const rows = await db.factorReturnDaily.findMany({
    where: {
      factorCode: { in: factorCodes },
      tradeDate: { gte: new Date(start), lte: new Date(end) },
    },
    select: { factorCode: true, value: true },
  });

  const sums: Record<string, number> = {};
  for (const row of rows) {
    sums[row.factorCode] = (sums[row.factorCode] ?? 0) + Number(row.value);
  }

  return factorCodes.map((code) => ({
    code,
    shockValue: sums[code] ?? 0,
  }));
}

/** Run a scenario against the portfolio's current factor exposures. */
export async function runScenario(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
  scenarioKey: string,
  customShocks?: { code: string; shockValue: number }[],
): Promise<ScenarioResult | null> {
  const preset = resolveModel(model);
  const factorCodes = preset.factors as FactorCode[];

  // Get portfolio betas from engine
  const engineResult = await runFactorEngine({
    portfolioId,
    model,
    window,
  });
  if (!engineResult) return null;

  const portfolioBetas = engineResult.endFit.betas;

  // Build scenario definition
  let scenario: ScenarioDefinition;

  if (customShocks) {
    scenario = {
      key: "custom",
      label: "Custom Shock",
      description: "User-defined factor shock.",
      shocks: customShocks
        .filter((s) => factorCodes.includes(s.code as FactorCode))
        .map((s) => ({ code: s.code as FactorCode, shockValue: s.shockValue })),
    };
  } else {
    const synthetic = SYNTHETIC_SCENARIOS.find((s) => s.key === scenarioKey);
    if (synthetic) {
      scenario = synthetic;
    } else {
      const historical = HISTORICAL_SCENARIO_KEYS.find((h) => h.key === scenarioKey);
      if (!historical) return null;
      const shocks = await computeHistoricalShocks(
        factorCodes,
        historical.historicalWindow.start,
        historical.historicalWindow.end,
      );
      scenario = {
        key: historical.key,
        label: historical.label,
        description: historical.description,
        shocks,
        isHistorical: true,
        historicalWindow: historical.historicalWindow,
      };
    }
  }

  return applyFactorShock(portfolioBetas, factorCodes, scenario);
}

/** Compute the best/worst shock sensitivity table. */
export async function getSensitivityTable(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
): Promise<SensitivityEntry[] | null> {
  const preset = resolveModel(model);
  const factorCodes = preset.factors as FactorCode[];

  const engineResult = await runFactorEngine({ portfolioId, model, window });
  if (!engineResult) return null;

  // Factor annual vols from covariance diagonal
  const { covMatrix } = engineResult.risk;
  const annualVols = factorCodes.map((_, i) => Math.sqrt(Math.max(0, covMatrix[i]?.[i] ?? 0)));

  return computeSensitivityTable(engineResult.endFit.betas, factorCodes, annualVols);
}
