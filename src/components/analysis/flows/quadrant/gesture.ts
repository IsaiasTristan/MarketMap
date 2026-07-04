/**
 * Pointer-gesture disambiguation for the crowding × conviction scatter.
 *
 * One `<svg>` hosts hover, click-through, box-select, brush-zoom and pan. A
 * single mousedown-classified gesture kind drives which behavior runs, so the
 * modes never fight over the same drag. This module is the pure decision layer
 * (no React/DOM); the chart wires the state machine around it.
 */
import type { QueryRect } from "./spatialIndex";

export type Gesture = "brush" | "pan" | "select" | "click";

export interface Point {
  x: number;
  y: number;
}

/**
 * Classify a starting gesture from the modifiers and context at mousedown:
 * - Shift → brush-zoom (draw a zoom rectangle).
 * - Space held AND already zoomed → pan the view.
 * - press began on a mark → click-through (resolved on mouseup by drag distance).
 * - otherwise (press on empty canvas) → box-select.
 * Shift wins over everything; pan requires an active zoom to have somewhere to go.
 */
export function classifyGesture(m: { shiftKey: boolean; spaceKey: boolean; onMark: boolean; zoomed: boolean }): Gesture {
  if (m.shiftKey) return "brush";
  if (m.spaceKey && m.zoomed) return "pan";
  if (m.onMark) return "click";
  return "select";
}

/** Axis-aligned rect from two drag corners, normalized so x0≤x1 and y0≤y1. */
export function normalizeRect(a: Point, b: Point): QueryRect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/** Euclidean distance between two points (used to tell a click from a drag). */
export function dragDistance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
