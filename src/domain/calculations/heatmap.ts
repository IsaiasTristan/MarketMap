import type { MetricKind } from "@/domain/entities/analytics";

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Diverging heat ramp (Bloomberg-style): saturated red at most negative,
 * neutral gray at zero, saturated green at most positive. Midpoint is always
 * gray so "near zero" reads clearly (unlike red↔green through black).
 *
 * Keep endpoint RGBs in sync with comments in `analysis.css` --heat-*.
 */
const HEAT_NEUTRAL = { r: 70, g: 70, b: 70 };
const HEAT_NEG_END = { r: 180, g: 30, b: 30 };
const HEAT_POS_END = { r: 30, g: 150, b: 30 };

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(
  from: { r: number; g: number; b: number },
  to: { r: number; g: number; b: number },
  t: number,
): string {
  const u = clamp01(t);
  return `rgb(${lerpChannel(from.r, to.r, u)},${lerpChannel(from.g, to.g, u)},${lerpChannel(from.b, to.b, u)})`;
}

/**
 * Signed heat: `value` in [-span, span] maps from red → gray → green.
 * `span` is the positive magnitude that maps to full saturation.
 */
export function heatSignedBloomberg(value: number, span: number): string {
  const s = Math.max(span, 1e-12);
  const t = Math.max(-1, Math.min(1, value / s));
  if (t === 0) return lerpRgb(HEAT_NEUTRAL, HEAT_NEUTRAL, 0);
  if (t < 0) return lerpRgb(HEAT_NEUTRAL, HEAT_NEG_END, Math.abs(t));
  return lerpRgb(HEAT_NEUTRAL, HEAT_POS_END, t);
}

/**
 * Sequential heat: non-negative `value` in [0, span] ramps from neutral gray
 * to a saturated red or green endpoint. Use for one-sided metrics like
 * realised vol (red = high) or R² (green = high fit).
 */
export function heatSequentialBloomberg(
  value: number,
  span: number,
  hue: "red" | "green",
): string {
  const s = Math.max(span, 1e-12);
  const t = Math.max(0, Math.min(1, value / s));
  return lerpRgb(HEAT_NEUTRAL, hue === "red" ? HEAT_NEG_END : HEAT_POS_END, t);
}

/**
 * Heat for a regression t-statistic, keyed on |t| (sign-agnostic — t = +x
 * and t = -x produce the same colour because significance is about magnitude,
 * not direction).
 *   |t| = 0      → darkest red       (clearly not significant)
 *   |t| ≈ 1.25   → neutral gray
 *   |t| = 2      → ~60 % green       (around the 95 % threshold)
 *   |t| ≥ 3      → darkest green     (highly significant)
 * Uses the project's standard red/neutral/green endpoints via
 * `heatSignedBloomberg`, so the swatch matches every other heat cell.
 */
export function heatTStatBloomberg(t: number): string {
  if (!Number.isFinite(t)) return lerpRgb(HEAT_NEUTRAL, HEAT_NEUTRAL, 0);
  const a = Math.min(Math.abs(t), 3);
  // Piecewise remap of |t| to a [-1, +1] multiplier so the existing signed
  // ramp draws darkest red at 0, visibly green at 2, darkest green at 3+.
  const m = a <= 2 ? -1 + 0.8 * a : 0.6 + 0.4 * (a - 2);
  return heatSignedBloomberg(m, 1);
}

/**
 * Cohort-percentile heat. `pct` is the value's percentile rank within its
 * cohort, expressed as a fraction in [0, 1].
 *
 *   - "signed": pct=0.5 → neutral, pct=0 → red, pct=1 → green. Use for
 *     symmetric metrics where the cohort spans both signs (factor betas,
 *     return contributions, alpha, residual drift).
 *   - "moreGreen": pct=0 → neutral, pct=1 → green. Use for one-sided
 *     "more is better" metrics (R²).
 *   - "moreRed": pct=0 → neutral, pct=1 → red. Use for one-sided "more
 *     is worse" metrics (realised volatility).
 *
 * The cohort-percentile heat ramp replaces per-column-span shading: a
 * cell's intensity now reflects how extreme it is *within its peers* —
 * a "tight column" no longer dilutes a meaningful outlier.
 */
export function heatPercentileBloomberg(
  pct: number,
  direction: "signed" | "moreGreen" | "moreRed",
): string {
  const p = clamp01(pct);
  if (direction === "signed") {
    // Map pct ∈ [0, 1] to [-1, 1] and reuse the signed ramp.
    return heatSignedBloomberg(p * 2 - 1, 1);
  }
  return lerpRgb(
    HEAT_NEUTRAL,
    direction === "moreGreen" ? HEAT_POS_END : HEAT_NEG_END,
    p,
  );
}

/**
 * Desaturated/dim version of any heat color. Used to mute the row-level
 * summary heat (R², Vol) on rows where every factor cell was masked by the
 * sig gate — keeps the cell readable but takes the visual emphasis away.
 */
export function dimHeatColor(): string {
  return "rgba(255,255,255,0.025)";
}

/** Signed heat with value clamped to column symmetric span (correlation grids). */
export function divergingHeatColor(value: number, colMin: number, colMax: number): string {
  const span = Math.max(Math.abs(colMax), Math.abs(colMin), 1e-9);
  const clamped = Math.max(Math.min(value, span), -span);
  return heatSignedBloomberg(clamped, span);
}

/**
 * Map a numeric cell to RGB for heatmap backgrounds.
 * Return / excess / Sharpe: diverging red–gray–green.
 * Volatility: dark gray ramp (low → high) on black.
 */
export function heatmapRgb(
  value: number | null,
  metric: MetricKind,
  colMin: number,
  colMax: number,
): string {
  if (value == null || !Number.isFinite(value)) return "#121212";

  if (metric === "VOLATILITY") {
    if (colMax <= colMin) return "#141414";
    const t = clamp01((value - colMin) / (colMax - colMin));
    const base = 18 + Math.round(40 * t);
    return `rgb(${base},${base + 2},${base + 4})`;
  }

  const span = Math.max(Math.abs(colMax), Math.abs(colMin), 1e-9);
  return heatSignedBloomberg(value, span);
}
