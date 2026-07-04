/**
 * Deterministic greedy label placement for the crowding × conviction scatter.
 *
 * No force simulation, no randomness: candidates are ranked (forced danger-zone
 * labels first, then by score), and each is placed in the first of four fixed
 * candidate slots that clears the plot bounds, every already-placed label, and
 * every other candidate mark. A label with no free slot is dropped. Same input
 * → same output, always.
 */
import type { QUADRANT_CONFIG } from "./quadrantConfig";

export type Slot = "right" | "above-right" | "below-right" | "left";

export interface LabelInput {
  id: string;
  /** Mark center + radius, in pixel space. */
  x: number;
  y: number;
  r: number;
  text: string;
  /** |Δholders| * conviction — ranks non-forced labels. */
  score: number;
  /** Danger-zone callout — ranked ahead of all non-forced labels. */
  forced: boolean;
  /**
   * Coarse tier ranked ABOVE forced/score (higher wins). Default 0, so existing
   * callers are unaffected. Used by the semantic-zoom label budget to keep
   * user-pinned/foreground labels ahead of density-promoted ones.
   */
  priority?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel {
  id: string;
  text: string;
  /** Text anchor position (baseline), pixel space. */
  x: number;
  y: number;
  anchor: "start" | "end";
  slot: Slot;
  rect: Rect;
}

/** Rectangle the labels must stay within (the plot area, pixel space). */
export interface PlotBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlaceOpts {
  fontSize: number;
  charWidth: number;
  pad: number;
  slots: readonly Slot[];
}

/** Gap between a mark's edge and its label, in px. */
const LABEL_GAP = 3;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True if the axis-aligned rect overlaps the circle (closest-point test). */
function rectIntersectsCircle(rect: Rect, cx: number, cy: number, r: number): boolean {
  const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nearestX;
  const dy = cy - nearestY;
  return dx * dx + dy * dy < r * r;
}

function withinBounds(rect: Rect, b: PlotBounds): boolean {
  return rect.x >= b.x0 && rect.y >= b.y0 && rect.x + rect.w <= b.x1 && rect.y + rect.h <= b.y1;
}

/** Geometry for one candidate slot: the bounding rect + the text baseline anchor. */
function slotGeometry(
  m: LabelInput,
  slot: Slot,
  opts: PlaceOpts,
): { rect: Rect; x: number; y: number; anchor: "start" | "end" } {
  const textWidth = m.text.length * opts.charWidth;
  const w = textWidth + 2 * opts.pad;
  const h = opts.fontSize + 2 * opts.pad;
  const gap = m.r + LABEL_GAP;
  // Baseline offset that vertically centers text within a rect of height h.
  const baseInRect = opts.pad + opts.fontSize * 0.78;

  switch (slot) {
    case "right": {
      const anchorX = m.x + gap;
      const rect = { x: anchorX - opts.pad, y: m.y - h / 2, w, h };
      return { rect, x: anchorX, y: rect.y + baseInRect, anchor: "start" };
    }
    case "above-right": {
      const anchorX = m.x + gap;
      const rect = { x: anchorX - opts.pad, y: m.y - gap - h, w, h };
      return { rect, x: anchorX, y: rect.y + baseInRect, anchor: "start" };
    }
    case "below-right": {
      const anchorX = m.x + gap;
      const rect = { x: anchorX - opts.pad, y: m.y + gap, w, h };
      return { rect, x: anchorX, y: rect.y + baseInRect, anchor: "start" };
    }
    case "left": {
      const anchorX = m.x - gap;
      const rect = { x: anchorX - textWidth - opts.pad, y: m.y - h / 2, w, h };
      return { rect, x: anchorX, y: rect.y + baseInRect, anchor: "end" };
    }
  }
}

/**
 * Rank candidates and place each in its first free slot. `bounds` is the plot
 * rectangle; `opts.slots` is the ordered slot preference. Candidate marks act
 * as obstacles for every label but their own.
 */
export function placeLabels(inputs: LabelInput[], bounds: PlotBounds, opts: PlaceOpts): PlacedLabel[] {
  // Priority tier first (default 0), then forced (danger-zone), then score desc,
  // then id for a total, stable order. With all-default priority this is exactly
  // the previous (forced, score, id) ordering.
  const ranked = [...inputs].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.forced !== b.forced) return a.forced ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const placed: PlacedLabel[] = [];
  const placedRects: Rect[] = [];

  for (const m of ranked) {
    for (const slot of opts.slots) {
      const g = slotGeometry(m, slot, opts);
      if (!withinBounds(g.rect, bounds)) continue;
      if (placedRects.some((r) => rectsOverlap(g.rect, r))) continue;
      if (inputs.some((o) => o.id !== m.id && rectIntersectsCircle(g.rect, o.x, o.y, o.r))) continue;
      placed.push({ id: m.id, text: m.text, x: g.x, y: g.y, anchor: g.anchor, slot, rect: g.rect });
      placedRects.push(g.rect);
      break;
    }
  }
  return placed;
}

/** Build PlaceOpts from the shared chart config (keeps thresholds in one place). */
export function placeOptsFromConfig(cfg: typeof QUADRANT_CONFIG): PlaceOpts {
  return {
    fontSize: cfg.labels.fontSize,
    charWidth: cfg.labels.charWidth,
    pad: cfg.labels.pad,
    slots: cfg.labels.slots,
  };
}
