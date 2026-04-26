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
