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
  /** Top-right unwind risk: breadth > p75 AND conviction > p75 AND distributing. */
  danger: boolean;
}

export interface QuadrantModel {
  foreground: PlottedPoint[];
  background: PlottedPoint[];
  /** Rolling p75 boundaries (breadth %, conviction %) — danger zone + zone overlay. */
  p75Breadth: number;
  p75Conviction: number;
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
  breadthLine: number;
  convictionLine: number;
  trackedFunds: number;
}

/** p in [0,1] over an ASCENDING-sorted array (nearest-rank). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Config tick values that fall inside [lo, hi] — human values only, no auto-generation. */
function ticksInDomain(ticks: readonly number[], lo: number, hi: number): number[] {
  return ticks.filter((t) => t >= lo && t <= hi);
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

  // Rolling p75 boundaries over the plotted universe — used for the danger zone
  // (this commit) and the zone-annotation overlay (Task 8). Conviction p75 is
  // taken over positive convictions so null/zero names don't drag it down.
  const breadthSorted = pts.map((p) => p.breadth).sort((a, b) => a - b);
  const convPosSorted = pts.map((p) => p.conviction ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const p75Breadth = percentile(breadthSorted, cfg.dangerZone.breadthPercentile);
  const p75Conviction = percentile(convPosSorted, cfg.dangerZone.convictionPercentile);

  const foreground: PlottedPoint[] = [];
  const background: PlottedPoint[] = [];
  for (const p of pts) {
    const fg = isForeground(p, convictionBar);
    const danger = p.breadth > p75Breadth && (p.conviction ?? 0) > p75Conviction && p.deltaHolders < 0;
    const plotted: PlottedPoint = {
      ...p,
      layer: fg ? "foreground" : "background",
      r: fg ? flowRadius(p.deltaHolders) : cfg.colors.backgroundRadius,
      fill: fg ? flowColor(p.deltaHolders) : cfg.colors.background,
      score: Math.abs(p.deltaHolders) * (p.conviction ?? 0),
      danger,
    };
    (fg ? foreground : background).push(plotted);
  }

  // Log domains — no conviction cap, no pinned-outlier row. Conviction (y) floors
  // at 0.3% and ceils at p99.5, so the highest-conviction names simply sit near
  // the top rather than being clamped onto a cap line. Breadth (x) floors at the
  // breadth of a single fund (100/N) so the discrete low-holder columns spread out.
  const yFloor = cfg.axes.y.floor;
  const yCeil = Math.max(percentile(convPosSorted, cfg.axes.y.ceilPercentile), yFloor * 4);
  const xFloor = 100 / Math.max(1, payload.trackedFunds);
  const xCeil = Math.max(payload.breadthLine, ...pts.map((p) => p.breadth), xFloor * 2) * cfg.axes.x.ceilPad;

  return {
    foreground,
    background,
    p75Breadth,
    p75Conviction,
    xDomain: [xFloor, xCeil],
    yDomain: [yFloor, yCeil],
    xTicks: ticksInDomain(cfg.axes.x.ticks, xFloor, xCeil),
    yTicks: ticksInDomain(cfg.axes.y.ticks, yFloor, yCeil),
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

/**
 * Logarithmic pixel scales. Values outside the domain clamp to the plot edge —
 * a point is never off-canvas, and a null/zero conviction lands on the y-floor
 * (its true value still shows in the tooltip). Both domains are strictly
 * positive, so log is always defined after clamping.
 */
export function makeScales(model: QuadrantModel, rect: PlotRect): Scales {
  const [x0, x1] = model.xDomain;
  const [y0, y1] = model.yDomain;
  const lx0 = Math.log(x0);
  const lxSpan = Math.log(x1) - lx0 || 1;
  const ly0 = Math.log(y0);
  const lySpan = Math.log(y1) - ly0 || 1;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: (b) => rect.left + ((Math.log(clamp(b, x0, x1)) - lx0) / lxSpan) * rect.width,
    y: (c) => rect.top + rect.height - ((Math.log(clamp(c ?? y0, y0, y1)) - ly0) / lySpan) * rect.height,
  };
}
