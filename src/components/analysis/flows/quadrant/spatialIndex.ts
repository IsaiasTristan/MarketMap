/**
 * Uniform grid-bucket spatial index for the crowding × conviction scatter.
 *
 * Replaces the per-frame linear nearest-point scan so hit-testing stays cheap
 * as the plot gains ~300+ context marks and interaction modes (Alt-hover,
 * box-select, density promotion under zoom). Build is O(n); a nearest query
 * touches only the cells within the search radius; a rect query touches only
 * overlapped cells. Positions are PIXEL-space and change on zoom, so the index
 * is cheap to rebuild whenever positions change.
 *
 * Pure module — no React, no DOM.
 */

export interface IndexedPoint {
  ticker: string;
  x: number;
  y: number;
  /** Render radius, used by callers to size the acceptance threshold. */
  r: number;
}

export interface QueryRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Deterministic "is a nearer/better than b" comparison. Distance wins; on an
 * exact tie the lexicographically smaller ticker wins so the result never
 * depends on bucket iteration order. Callers (and the brute-force reference in
 * tests) use the same rule.
 */
function better(dist: number, ticker: string, bestDist: number, bestTicker: string | null): boolean {
  if (bestTicker === null) return true;
  if (dist < bestDist) return true;
  return dist === bestDist && ticker < bestTicker;
}

export interface SpatialIndex {
  /**
   * Nearest point within `searchRadius` of (px,py) for which `accept(p, dist)`
   * is true. `searchRadius` is a coarse upper bound that bounds which cells are
   * scanned; `accept` applies the real per-point threshold. Returns null when
   * nothing qualifies.
   */
  nearest(
    px: number,
    py: number,
    searchRadius: number,
    accept: (p: IndexedPoint, dist: number) => boolean,
  ): IndexedPoint | null;
  /** All points whose CENTER lies within `rect` (inclusive), sorted by ticker. */
  within(rect: QueryRect): IndexedPoint[];
}

export function buildSpatialIndex(points: IndexedPoint[], cellSize: number): SpatialIndex {
  const cs = Math.max(1, cellSize);
  const buckets = new Map<string, IndexedPoint[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const cellOf = (v: number) => Math.floor(v / cs);

  for (const p of points) {
    const k = key(cellOf(p.x), cellOf(p.y));
    const arr = buckets.get(k);
    if (arr) arr.push(p);
    else buckets.set(k, [p]);
  }

  return {
    nearest(px, py, searchRadius, accept) {
      const cx0 = cellOf(px - searchRadius);
      const cx1 = cellOf(px + searchRadius);
      const cy0 = cellOf(py - searchRadius);
      const cy1 = cellOf(py + searchRadius);
      let best: IndexedPoint | null = null;
      let bestDist = Infinity;
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = buckets.get(key(cx, cy));
          if (!arr) continue;
          for (const p of arr) {
            const d = Math.hypot(p.x - px, p.y - py);
            if (d > searchRadius) continue;
            if (!accept(p, d)) continue;
            if (better(d, p.ticker, bestDist, best?.ticker ?? null)) {
              best = p;
              bestDist = d;
            }
          }
        }
      }
      return best;
    },

    within(rect) {
      const x0 = Math.min(rect.x0, rect.x1);
      const x1 = Math.max(rect.x0, rect.x1);
      const y0 = Math.min(rect.y0, rect.y1);
      const y1 = Math.max(rect.y0, rect.y1);
      const cx0 = cellOf(x0);
      const cx1 = cellOf(x1);
      const cy0 = cellOf(y0);
      const cy1 = cellOf(y1);
      const out: IndexedPoint[] = [];
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const arr = buckets.get(key(cx, cy));
          if (!arr) continue;
          for (const p of arr) {
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
          }
        }
      }
      out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
      return out;
    },
  };
}
