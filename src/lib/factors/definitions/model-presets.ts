/**
 * Factor model preset definitions.
 * Each preset declares which factors to include in the joint OLS regression.
 */
import type { FactorCode, ModelPreset, ModelPresetName } from "@/types/factors";

export const MODEL_PRESETS: Record<ModelPresetName, ModelPreset> = {
  CAPM: {
    name: "CAPM",
    label: "CAPM (1-Factor)",
    description:
      "Capital Asset Pricing Model. Single market factor. Good baseline for beta estimation.",
    factors: ["MKT_RF"],
  },
  FF3: {
    name: "FF3",
    label: "Fama-French 3-Factor",
    description:
      "Market, Size (SMB), and Value (HML). Industry standard for explaining equity returns.",
    factors: ["MKT_RF", "SMB", "HML"],
  },
  CARHART4: {
    name: "CARHART4",
    label: "Carhart 4-Factor",
    description:
      "Fama-French 3-Factor plus Momentum. Widely used for mutual fund performance evaluation.",
    factors: ["MKT_RF", "SMB", "HML", "MOM"],
  },
  FF5: {
    name: "FF5",
    label: "Fama-French 5-Factor",
    description:
      "Market, Size, Value, Profitability (RMW), and Investment (CMA). Current academic standard.",
    factors: ["MKT_RF", "SMB", "HML", "RMW", "CMA"],
  },
  EXTENDED: {
    name: "EXTENDED",
    label: "Extended 6-Factor",
    description:
      "Fama-French 5 factors plus Momentum. The most complete model using available data.",
    factors: ["MKT_RF", "SMB", "HML", "RMW", "CMA", "MOM"],
  },
};

/** Resolve a model preset by name, defaulting to FF5. */
export function resolveModel(name: ModelPresetName | string): ModelPreset {
  return MODEL_PRESETS[name as ModelPresetName] ?? MODEL_PRESETS.FF5;
}

/** Minimum number of observations required for a regression with k factors.
 *  Rule: 2k + 30 to ensure meaningful degrees of freedom. */
export function minObservations(k: number): number {
  return 2 * k + 30;
}

/** All model preset names in display order. */
export const MODEL_PRESET_NAMES: ModelPresetName[] = [
  "CAPM",
  "FF3",
  "CARHART4",
  "FF5",
  "EXTENDED",
];

/** Factor codes that contribute to return attribution (excludes RF). */
export function getAttributionFactors(model: ModelPreset): FactorCode[] {
  return model.factors.filter((f): f is FactorCode => f !== "RF");
}
