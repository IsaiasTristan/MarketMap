/**
 * Pointer-gesture disambiguation for the crowding × conviction scatter.
 *
 * One `<svg>` hosts hover, click-through, box-select, brush-zoom and pan. A
 * single mousedown-classified gesture kind drives which behavior runs, so the
 * modes never fight over the same drag. This module is the pure decision layer
 * (no React/DOM); the chart wires the state machine around it.
 */
import type { QueryRect } from "./spatialIndex";

export type Gesture = "pan" | "select";

export interface Point {
  x: number;
  y: number;
}

/**
 * Classify a starting drag from the mouse button (map-style navigation):
 * - Right button → box-select (draw the region-inspector rectangle).
 * - Left button → pan (grab-scroll).
 * A left press with no drag is resolved as a click (ledger) on mouseup by drag
 * distance — that's handled by the caller, not here. `onMark` is accepted for
 * call-site symmetry but no longer changes the drag kind (a left-drag from a
 * mark still pans, like dragging a map).
 */
export function classifyGesture(m: { rightButton: boolean; onMark: boolean }): Gesture {
  return m.rightButton ? "select" : "pan";
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
