/**
 * HORIZON presets — single source of truth for the factor regression window
 * couples (value in trading days, display label, secondary "365 day" copy).
 *
 * Used by:
 *   - FactorToolbar (segmented control)
 *   - PortfolioTotalsPanel (waterfall titles / subtitles)
 *
 * Values must stay in sync with `FactorWindow` in the analysis store and
 * `GRID_CACHE_WINDOWS` so every horizon is served from the precomputed
 * per-stock grid cache.
 */
import type { FactorWindow } from "@/store/analysis";

export interface HorizonPreset {
  value: FactorWindow;
  label: string;
  sub: string;
}

export const HORIZON_PRESETS: HorizonPreset[] = [
  { value: 63, label: "Short-Term", sub: "90 day" },
  { value: 252, label: "Standard", sub: "365 day" },
  { value: 504, label: "Long-Term", sub: "2 year" },
  { value: 756, label: "Very Long-Term", sub: "3 year" },
];

export function getHorizonPreset(value: FactorWindow): HorizonPreset {
  return HORIZON_PRESETS.find((p) => p.value === value) ?? HORIZON_PRESETS[1]!;
}
