import type { MetricKind } from "@/domain/entities/analytics";

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Map a numeric cell to RGB for heatmap backgrounds (institutional, muted).
 * For return metrics: red (negative) → neutral → green (positive).
 * Volatility: light (low) → dark (high).
 * Sharpe: red → neutral → green.
 */
export function heatmapRgb(
  value: number | null,
  metric: MetricKind,
  colMin: number,
  colMax: number
): string {
  if (value == null || !Number.isFinite(value)) return "#e8eaef";

  if (metric === "VOLATILITY") {
    if (colMax <= colMin) return "#eef0f4";
    const t = clamp01((value - colMin) / (colMax - colMin));
    const base = 240 - Math.round(95 * t);
    return `rgb(${base},${base + 8},${base + 14})`;
  }

  const span = Math.max(Math.abs(colMax), Math.abs(colMin), 1e-9);
  const t = clamp01((value + span) / (2 * span));

  if (metric === "SHARPE") {
    if (t < 0.5) {
      const u = t / 0.5;
      return `rgb(${200 + Math.round(40 * u)},${180 - Math.round(80 * u)},${170 - Math.round(40 * u)})`;
    }
    const u = (t - 0.5) / 0.5;
    return `rgb(${160 - Math.round(90 * u)},${180 - Math.round(40 * u)},${150 - Math.round(50 * u)})`;
  }

  if (t < 0.5) {
    const u = t / 0.5;
    return `rgb(${210 + Math.round(30 * u)},${200 - Math.round(120 * u)},${198 - Math.round(100 * u)})`;
  }
  const u = (t - 0.5) / 0.5;
  return `rgb(${180 - Math.round(100 * u)},${200 - Math.round(40 * u)},${160 - Math.round(70 * u)})`;
}
