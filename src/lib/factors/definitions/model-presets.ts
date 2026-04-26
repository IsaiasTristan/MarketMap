/**
 * Factor model preset definitions.
 * Each preset declares which factors to include in the joint OLS regression.
 */
import type { FactorCode, ModelPreset, ModelPresetName } from "@/types/factors";

/** The 14 factors that make up the MACRO14 institutional macro + style model. */
export const MACRO14_FACTORS: FactorCode[] = [
  // Macro asset-class beta (7)
  "EQ",
  "LOCAL_EQ",
  "RATES",
  "COMM",
  "EM",
  "FX",
  "INFL",
  // Style risk premia (7)
  "SHORT_VOL",
  "TREND",
  "BAB",
  "MOM",
  "QMJ",
  "HML",
  "CROWD",
];

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
      "Fama-French 5 factors plus Momentum. The most complete academic preset.",
    factors: ["MKT_RF", "SMB", "HML", "RMW", "CMA", "MOM"],
  },
  MACRO14: {
    name: "MACRO14",
    label: "Institutional Macro + Style (14)",
    description:
      "Multi-asset macro factors (Equity, Rates, Commodities, EM, FX, Inflation, Local Equity) plus seven style risk premia (Short Vol, Trend, Low Risk, Momentum, Quality, Value, Crowding). Default model for the institutional Factors tab.",
    factors: MACRO14_FACTORS,
  },
};

/** Resolve a model preset by name, defaulting to MACRO14. */
export function resolveModel(name: ModelPresetName | string): ModelPreset {
  return MODEL_PRESETS[name as ModelPresetName] ?? MODEL_PRESETS.MACRO14;
}

/** Minimum number of observations required for a regression with k factors.
 *  Rule: 2k + 30 to ensure meaningful degrees of freedom. */
export function minObservations(k: number): number {
  return 2 * k + 30;
}

/**
 * Model presets shown in the UI. Trimmed to the institutional set per
 * product decision (Apr 2026): the MACRO14 macro+style default plus the
 * two academic Fama-French baselines. CAPM / Carhart4 / Extended remain
 * defined in `MODEL_PRESETS` for backward compatibility with old persisted
 * snapshots and saved settings, but are intentionally hidden from the
 * Model dropdown.
 */
export const MODEL_PRESET_NAMES: ModelPresetName[] = [
  "MACRO14",
  "FF5",
  "FF3",
];

/** Factor codes that contribute to return attribution (excludes RF). */
export function getAttributionFactors(model: ModelPreset): FactorCode[] {
  return model.factors.filter((f): f is FactorCode => f !== "RF");
}
