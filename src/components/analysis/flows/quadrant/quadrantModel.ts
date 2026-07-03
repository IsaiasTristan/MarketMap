/**
 * Pure derivation layer for the crowding × conviction chart — no React, no DOM.
 * Splits the universe into a signal FOREGROUND and a context BACKGROUND,
 * computes domains/ticks, and builds the pixel scales the SVG renderer uses.
 */
import type { QuadrantPayload, QuadrantPoint } from "@/server/services/institutional/institutional-query.service";
import { QUADRANT_CONFIG } from "./quadrantConfig";

export type Layer = "foreground" | "background";

/**
 * Flow-direction color — accumulating (Δ>0) blue, distributing (Δ<0) red,
 * no material change (Δ==0) neutral gray. Δholders is the price-adjusted
 * signal (holding is binary on shares>0, so appreciation cannot create a delta).
 */
export function flowColor(deltaHolders: number): string {
  const c = QUADRANT_CONFIG.colors;
  if (deltaHolders > 0) return c.accumulating;
  if (deltaHolders < 0) return c.distributing;
  return c.neutral;
}

/** Foreground radius grows with the magnitude of the holder swing, clamped. */
export function flowRadius(deltaHolders: number): number {
  const r = QUADRANT_CONFIG.radius;
  return Math.min(r.max, r.base + r.perDelta * Math.abs(deltaHolders));
}

export interface PlottedPoint extends QuadrantPoint {
  layer: Layer;
  r: number;
  fill: string;
  /** |Δholders| * conviction — label/interestingness priority. */
  score: number;
}

export interface QuadrantModel {
  foreground: PlottedPoint[];
  background: PlottedPoint[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
  breadthLine: number;
  convictionLine: number;
  trackedFunds: number;
}

/** p in [0,1] over an ASCENDING-sorted array (nearest-rank, matches the old p96 clamp). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** 1/2/5-mantissa "nice" ticks for a [0, max] linear domain. */
function linearTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const rawStep = max / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(4)));
  return ticks;
}

function isForeground(p: QuadrantPoint, convictionBar: number): boolean {
  const cfg = QUADRANT_CONFIG.foreground;
  if (cfg.demoteZeroDelta && p.deltaHolders === 0) return false;
  if (Math.abs(p.deltaHolders) >= cfg.minAbsDelta) return true;
  return p.fundsHolding >= cfg.minHolders && (p.conviction ?? 0) >= convictionBar;
}

export function buildQuadrantModel(payload: QuadrantPayload): QuadrantModel {
  const cfg = QUADRANT_CONFIG;
  const pts = payload.points;

  const allConvSorted = pts.map((p) => p.conviction ?? 0).sort((a, b) => a - b);
  const convictionBar = percentile(allConvSorted, cfg.foreground.convictionPercentile);

  const foreground: PlottedPoint[] = [];
  const background: PlottedPoint[] = [];
  for (const p of pts) {
    const fg = isForeground(p, convictionBar);
    const plotted: PlottedPoint = {
      ...p,
      layer: fg ? "foreground" : "background",
      r: fg ? flowRadius(p.deltaHolders) : cfg.colors.backgroundRadius,
      fill: fg ? flowColor(p.deltaHolders) : cfg.colors.background,
      score: Math.abs(p.deltaHolders) * (p.conviction ?? 0),
    };
    (fg ? foreground : background).push(plotted);
  }

  // Linear domains with a p99.5 conviction cap (log axes replace this in Task 3).
  const convSorted = pts.map((p) => p.conviction ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const yMax = Math.max(percentile(convSorted, cfg.axes.y.ceilPercentile), payload.convictionLine * 2, 0.5) * 1.05;
  const xMax = Math.max(payload.breadthLine, ...pts.map((p) => p.breadth), 1) * 1.03;

  return {
    foreground,
    background,
    xDomain: [0, xMax],
    yDomain: [0, yMax],
    xTicks: linearTicks(xMax),
    yTicks: linearTicks(yMax),
    breadthLine: payload.breadthLine,
    convictionLine: payload.convictionLine,
    trackedFunds: payload.trackedFunds,
  };
}

// ── pixel scales ─────────────────────────────────────────────────────────────
export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Scales {
  x: (breadth: number) => number;
  y: (conviction: number | null) => number;
}

/** Values outside the domain clamp to the plot edge — a point is never off-canvas. */
export function makeScales(model: QuadrantModel, rect: PlotRect): Scales {
  const [x0, x1] = model.xDomain;
  const [y0, y1] = model.yDomain;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: (b) => rect.left + ((clamp(b, x0, x1) - x0) / (x1 - x0 || 1)) * rect.width,
    y: (c) => rect.top + rect.height - ((clamp(c ?? 0, y0, y1) - y0) / (y1 - y0 || 1)) * rect.height,
  };
}
