import type { MetricKind } from "@/domain/entities/analytics";

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** RGB endpoints — keep in sync with `analysis.css` --heat-* */
const HEAT_POS_STRONG = { r: 0, g: 51, b: 0 };
const HEAT_POS_BRIGHT = { r: 0, g: 100, b: 0 };
const HEAT_NEG_STRONG = { r: 51, g: 0, b: 0 };
const HEAT_NEG_BRIGHT = { r: 139, g: 0, b: 0 };

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
 * Bloomberg-style signed heat: interpolate from dark to saturated by magnitude.
 * `span` is the positive magnitude that maps to full intensity (e.g. column half-range or 0.1 for monthly returns).
 */
export function heatSignedBloomberg(value: number, span: number): string {
  const s = Math.max(span, 1e-12);
  if (value >= 0) {
    return lerpRgb(HEAT_POS_STRONG, HEAT_POS_BRIGHT, value / s);
  }
  return lerpRgb(HEAT_NEG_STRONG, HEAT_NEG_BRIGHT, Math.abs(value) / s);
}

/** Signed heat with value clamped to column symmetric span (for correlation-style grids). */
export function divergingHeatColor(value: number, colMin: number, colMax: number): string {
  const span = Math.max(Math.abs(colMax), Math.abs(colMin), 1e-9);
  const clamped = Math.max(Math.min(value, span), -span);
  return heatSignedBloomberg(clamped, span);
}

/**
 * Map a numeric cell to RGB for heatmap backgrounds.
 * Return / excess / Sharpe: Bloomberg green (positive) vs crimson (negative).
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
