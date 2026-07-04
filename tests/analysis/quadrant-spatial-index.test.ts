import { describe, it, expect } from "vitest";
import { buildSpatialIndex, type IndexedPoint, type QueryRect } from "@/components/analysis/flows/quadrant/spatialIndex";

/** Deterministic PRNG so the property test is reproducible without Math.random. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function cloud(n: number, seed: number): IndexedPoint[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => ({
    ticker: `T${String(i).padStart(3, "0")}`,
    x: rng() * 800,
    y: rng() * 400,
    r: 2 + rng() * 10,
  }));
}

/** Brute-force reference with the SAME tie-break rule the index uses. */
function bruteNearest(
  pts: IndexedPoint[],
  px: number,
  py: number,
  searchRadius: number,
  accept: (p: IndexedPoint, d: number) => boolean,
): IndexedPoint | null {
  let best: IndexedPoint | null = null;
  let bestDist = Infinity;
  for (const p of pts) {
    const d = Math.hypot(p.x - px, p.y - py);
    if (d > searchRadius) continue;
    if (!accept(p, d)) continue;
    const isBetter = best === null || d < bestDist || (d === bestDist && p.ticker < best.ticker);
    if (isBetter) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

describe("buildSpatialIndex.nearest", () => {
  it("returns null on an empty index", () => {
    const idx = buildSpatialIndex([], 32);
    expect(idx.nearest(10, 10, 50, () => true)).toBeNull();
  });

  it("matches a brute-force scan for random clouds, accept-all", () => {
    const pts = cloud(400, 7);
    const idx = buildSpatialIndex(pts, 32);
    const rng = makeRng(99);
    for (let q = 0; q < 200; q++) {
      const px = rng() * 800;
      const py = rng() * 400;
      const radius = 5 + rng() * 60;
      const a = idx.nearest(px, py, radius, () => true);
      const b = bruteNearest(pts, px, py, radius, () => true);
      expect(a?.ticker ?? null).toBe(b?.ticker ?? null);
    }
  });

  it("matches a brute-force scan with a per-point radius threshold (hitTest semantics)", () => {
    const pts = cloud(300, 13);
    const idx = buildSpatialIndex(pts, 40);
    const HIT_SLOP = 4;
    const MIN_HIT = 12;
    const accept = (p: IndexedPoint, d: number) => d <= Math.max(p.r + HIT_SLOP, MIN_HIT);
    const rng = makeRng(41);
    for (let q = 0; q < 200; q++) {
      const px = rng() * 800;
      const py = rng() * 400;
      const a = idx.nearest(px, py, Math.max(...pts.map((p) => p.r)) + HIT_SLOP + MIN_HIT, accept);
      const b = bruteNearest(pts, px, py, 1000, accept);
      expect(a?.ticker ?? null).toBe(b?.ticker ?? null);
    }
  });

  it("is independent of cell size (32 vs 8 vs 200 give identical results)", () => {
    const pts = cloud(250, 3);
    const rng = makeRng(5);
    for (let q = 0; q < 100; q++) {
      const px = rng() * 800;
      const py = rng() * 400;
      const r = 30;
      const a = buildSpatialIndex(pts, 32).nearest(px, py, r, () => true);
      const b = buildSpatialIndex(pts, 8).nearest(px, py, r, () => true);
      const c = buildSpatialIndex(pts, 200).nearest(px, py, r, () => true);
      expect(a?.ticker).toBe(b?.ticker);
      expect(a?.ticker).toBe(c?.ticker);
    }
  });
});

describe("buildSpatialIndex.within", () => {
  const pts: IndexedPoint[] = [
    { ticker: "A", x: 10, y: 10, r: 3 },
    { ticker: "B", x: 100, y: 100, r: 3 },
    { ticker: "C", x: 200, y: 50, r: 3 },
    { ticker: "D", x: 100, y: 100, r: 3 }, // coincident with B
  ];

  it("returns centers inside the rect, sorted by ticker", () => {
    const idx = buildSpatialIndex(pts, 32);
    const rect: QueryRect = { x0: 0, y0: 0, x1: 150, y1: 150 };
    expect(idx.within(rect).map((p) => p.ticker)).toEqual(["A", "B", "D"]);
  });

  it("is inclusive on the boundary", () => {
    const idx = buildSpatialIndex(pts, 32);
    expect(idx.within({ x0: 100, y0: 100, x1: 100, y1: 100 }).map((p) => p.ticker)).toEqual(["B", "D"]);
  });

  it("normalizes inverted rects (drag in any direction)", () => {
    const idx = buildSpatialIndex(pts, 32);
    const forward = idx.within({ x0: 0, y0: 0, x1: 150, y1: 150 });
    const inverted = idx.within({ x0: 150, y0: 150, x1: 0, y1: 0 });
    expect(inverted).toEqual(forward);
  });

  it("returns empty when nothing is inside", () => {
    const idx = buildSpatialIndex(pts, 32);
    expect(idx.within({ x0: 500, y0: 300, x1: 600, y1: 400 })).toEqual([]);
  });
});
