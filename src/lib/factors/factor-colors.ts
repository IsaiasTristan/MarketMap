/**
 * Per-factor accent colors for the MACRO14 model.
 *
 * Used to give each factor panel its own bright, well-separated identity in
 * presentation surfaces (e.g. the Factor Top Movers section headers). A fixed
 * map — not a hash — keeps the 14 hues deliberately distinct and high-contrast
 * against the near-black analysis canvas, with no risk of two factors
 * collapsing onto the same color.
 */
import type { FactorCode } from "@/types/factors";

const FACTOR_ACCENT: Partial<Record<FactorCode, string>> = {
  // Macro asset-class beta (7)
  EQ: "#4fa8ff",
  LOCAL_EQ: "#00bfa5",
  RATES: "#f5b301",
  COMM: "#ff7a33",
  EM: "#c879ff",
  FX: "#ff5fa8",
  INFL: "#d4ff3f",
  // Style risk premia (7)
  SHORT_VOL: "#5fd9d9",
  TREND: "#ffd24d",
  BAB: "#8a9bff",
  MOM: "#ff8f5f",
  QMJ: "#6fe07a",
  HML: "#f0a6ff",
  CROWD: "#b0c4ff",
};

const FALLBACK_ACCENT = "#8a8a8a";

/** Stable bright accent color for a factor code (neutral gray fallback). */
export function factorAccentColor(code: FactorCode): string {
  return FACTOR_ACCENT[code] ?? FALLBACK_ACCENT;
}
