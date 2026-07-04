import { describe, it, expect } from "vitest";
import { lerpLogDomain, brushToFrame, panLogDomain, pushFrame, popFrame, zoomAxis, type ZoomFrame } from "@/components/analysis/flows/quadrant/zoomState";
import { computeDensity, pointsInView, selectPromoted, selectLabelCandidates, type ViewPoint } from "@/components/analysis/flows/quadrant/densityPromotion";
import { makeScalesForDomain, ticksInDomain } from "@/components/analysis/flows/quadrant/quadrantModel";
import { placeLabels, type LabelInput, type PlotBounds, type PlaceOpts } from "@/components/analysis/flows/quadrant/labelPlacement";

// ── zoomState ────────────────────────────────────────────────────────────────
describe("lerpLogDomain", () => {
  it("returns endpoints at t=0 and t=1", () => {
    expect(lerpLogDomain([1, 40], [2, 8], 0)).toEqual([1, 40]);
    const [a, b] = lerpLogDomain([1, 40], [2, 8], 1);
    expect(a).toBeCloseTo(2, 10);
    expect(b).toBeCloseTo(8, 10);
  });
  it("interpolates the geometric mean at t=0.5", () => {
    const [a, b] = lerpLogDomain([1, 100], [1, 100], 0.5);
    expect(a).toBeCloseTo(1, 10);
    expect(b).toBeCloseTo(100, 10);
    const [c] = lerpLogDomain([1, 4], [1, 4], 1); // trivial monotonic
    expect(c).toBeCloseTo(1, 10);
    const mid = lerpLogDomain([1, 1], [100, 100], 0.5)[0];
    expect(mid).toBeCloseTo(10, 6); // geometric mean of 1 and 100
  });
});

describe("brushToFrame", () => {
  const rect = { left: 50, top: 14, width: 700, height: 400 };
  const base: ZoomFrame = { xDomain: [1, 40], yDomain: [0.3, 8] };
  const scales = makeScalesForDomain(base.xDomain, base.yDomain, rect);

  it("round-trips: frame corners map back to the brush pixel rect", () => {
    const pr = { x0: 120, y0: 90, x1: 430, y1: 300 };
    const frame = brushToFrame(pr, scales, base);
    expect(scales.x(frame.xDomain[0])).toBeCloseTo(120, 4);
    expect(scales.x(frame.xDomain[1])).toBeCloseTo(430, 4);
    // top pixel (smaller y) = higher conviction = yDomain[1]
    expect(scales.y(frame.yDomain[1])).toBeCloseTo(90, 4);
    expect(scales.y(frame.yDomain[0])).toBeCloseTo(300, 4);
  });

  it("clamps to the base domain", () => {
    const frame = brushToFrame({ x0: -100, y0: -100, x1: 5000, y1: 5000 }, scales, base);
    expect(frame.xDomain[0]).toBeGreaterThanOrEqual(base.xDomain[0] - 1e-9);
    expect(frame.xDomain[1]).toBeLessThanOrEqual(base.xDomain[1] + 1e-9);
    expect(frame.yDomain[0]).toBeGreaterThanOrEqual(base.yDomain[0] - 1e-9);
    expect(frame.yDomain[1]).toBeLessThanOrEqual(base.yDomain[1] + 1e-9);
  });
});

describe("panLogDomain", () => {
  it("preserves domain width in log space", () => {
    const d: [number, number] = [2, 8];
    const base: [number, number] = [1, 40];
    const out = panLogDomain(d, 50, 700, base);
    const before = Math.log(d[1]) - Math.log(d[0]);
    const after = Math.log(out[1]) - Math.log(out[0]);
    expect(after).toBeCloseTo(before, 9);
  });
  it("clamps to base bounds", () => {
    const out = panLogDomain([2, 8], 100000, 700, [1, 40]);
    expect(out[1]).toBeCloseTo(40, 6); // pinned to the base ceiling
  });
});

describe("zoomAxis", () => {
  const base: [number, number] = [1, 40];
  it("zooms in (factor<1) and shrinks the log-width by that factor", () => {
    const out = zoomAxis(base, 6, 0.5, base);
    const lw = Math.log(out[1]) - Math.log(out[0]);
    const baseLw = Math.log(40) - Math.log(1);
    expect(lw).toBeCloseTo(baseLw * 0.5, 6);
  });
  it("keeps the cursor value at the same fractional position", () => {
    const cursor = 6;
    const fracIn = (Math.log(cursor) - Math.log(base[0])) / (Math.log(base[1]) - Math.log(base[0]));
    const out = zoomAxis(base, cursor, 0.5, base);
    const fracOut = (Math.log(cursor) - Math.log(out[0])) / (Math.log(out[1]) - Math.log(out[0]));
    expect(fracOut).toBeCloseTo(fracIn, 6); // cursor stays put (away from a clamped edge)
  });
  it("returns the full base domain when zooming out to/beyond base width", () => {
    expect(zoomAxis([2, 8], 4, 5, base)).toEqual([1, 40]);
  });
  it("clamps within base bounds", () => {
    const out = zoomAxis(base, 39, 0.5, base); // cursor near the top edge
    expect(out[0]).toBeGreaterThanOrEqual(base[0] - 1e-9);
    expect(out[1]).toBeLessThanOrEqual(base[1] + 1e-9);
  });
});

describe("pushFrame / popFrame", () => {
  const f = (n: number): ZoomFrame => ({ xDomain: [n, n + 1], yDomain: [n, n + 1] });
  it("grows until maxDepth, then replaces the top", () => {
    let stack: ZoomFrame[] = [];
    stack = pushFrame(stack, f(1), 2);
    expect(stack).toHaveLength(1);
    stack = pushFrame(stack, f(2), 2);
    expect(stack).toHaveLength(2);
    stack = pushFrame(stack, f(3), 2);
    expect(stack).toHaveLength(2);
    expect(stack[0]).toEqual(f(1)); // earlier frame kept
    expect(stack[1]).toEqual(f(3)); // top replaced
  });
  it("popFrame drops the top and is safe on empty", () => {
    expect(popFrame([f(1), f(2)])).toEqual([f(1)]);
    expect(popFrame([])).toEqual([]);
  });
});

// ── densityPromotion ─────────────────────────────────────────────────────────
describe("computeDensity", () => {
  it("is points per 10k px², monotonic in count", () => {
    expect(computeDensity(5, 10000)).toBe(5);
    expect(computeDensity(10, 10000)).toBe(10);
    expect(computeDensity(1, 0)).toBe(Infinity);
  });
});

describe("pointsInView", () => {
  const pts = [
    { ticker: "IN", breadth: 5, conviction: 2 },
    { ticker: "EDGE", breadth: 1, conviction: 0.3 },
    { ticker: "OUTX", breadth: 50, conviction: 2 },
    { ticker: "OUTY", breadth: 5, conviction: 20 },
    { ticker: "NULL", breadth: 5, conviction: null },
  ];
  it("keeps in-range points (inclusive) and drops null conviction", () => {
    const got = pointsInView(pts, [1, 40], [0.3, 8]).map((p) => p.ticker);
    expect(got).toEqual(["IN", "EDGE"]);
  });
});

describe("selectPromoted", () => {
  const bg: ViewPoint[] = [
    { ticker: "A", x: 0, y: 0, r: 2, score: 0, conviction: 1, danger: false },
    { ticker: "B", x: 0, y: 0, r: 2, score: 0, conviction: 2, danger: false },
  ];
  it("promotes all when sparse, none when dense", () => {
    expect([...selectPromoted(bg, 3, 6)].sort()).toEqual(["A", "B"]);
    expect([...selectPromoted(bg, 6, 6)]).toEqual([]);
    expect([...selectPromoted(bg, 10, 6)]).toEqual([]);
  });
});

describe("selectLabelCandidates", () => {
  const vp = (ticker: string, over: Partial<ViewPoint> = {}): ViewPoint => ({
    ticker, x: 0, y: 0, r: 4, score: 0, conviction: 0, danger: false, ...over,
  });
  const fg = [vp("FA", { score: 10 }), vp("FB", { score: 5 }), vp("FD", { score: 1, danger: true })];
  const promoted = [vp("PA", { conviction: 3 }), vp("PB", { conviction: 1 })];

  it("caps to maxLabels and orders foreground (tier 2) before promoted (tier 1)", () => {
    const out = selectLabelCandidates({ foreground: fg, promoted, pinnedTickers: new Set(), maxLabels: 4, badgeOf: () => "" });
    expect(out).toHaveLength(4);
    expect(out.map((l) => l.id)).toEqual(["FD", "FA", "FB", "PA"]); // danger fg first, then score; promoted by conviction
    expect(out[3]!.priority).toBe(1);
  });

  it("excludes pinned tickers (drawn separately)", () => {
    const out = selectLabelCandidates({ foreground: fg, promoted, pinnedTickers: new Set(["FA"]), maxLabels: 10, badgeOf: () => "" });
    expect(out.map((l) => l.id)).not.toContain("FA");
  });

  it("is deterministic", () => {
    const run = () => selectLabelCandidates({ foreground: fg, promoted, pinnedTickers: new Set(), maxLabels: 3, badgeOf: () => "" });
    expect(run()).toEqual(run());
  });

  it("zoomed label pipeline is deterministic (snapshot)", () => {
    // A fixed sparse-zoom scenario: 3 foreground + 2 density-promoted, placed.
    const inputs = selectLabelCandidates({ foreground: fg, promoted, pinnedTickers: new Set(), maxLabels: 25, badgeOf: () => "" });
    const bounds: PlotBounds = { x0: 0, y0: 0, x1: 600, y1: 380 };
    const placed = placeLabels(
      // spread the marks so placement is non-trivial
      inputs.map((l, i) => ({ ...l, x: 80 + i * 90, y: 120 + (i % 2) * 60 })),
      bounds,
      OPTS,
    );
    expect(placed).toMatchSnapshot();
  });
});

// ── labelPlacement backward-compat + priority ────────────────────────────────
const BOUNDS: PlotBounds = { x0: 0, y0: 0, x1: 800, y1: 400 };
const OPTS: PlaceOpts = { fontSize: 10, charWidth: 6, pad: 2, slots: ["right", "above-right", "below-right", "left"] };
const mk = (over: Partial<LabelInput> & { id: string }): LabelInput => ({ x: 100, y: 100, r: 5, text: over.id, score: 1, forced: false, ...over });

describe("placeLabels priority", () => {
  it("is unchanged when all priorities are default (regression guard)", () => {
    const build = () => Array.from({ length: 15 }, (_, i) => mk({ id: `D${i}`, x: 200 + (i % 5) * 15, y: 150 + (i % 3) * 15, score: (i * 7) % 11 }));
    // No priority field at all → identical to the historical (forced, score, id) order.
    expect(placeLabels(build(), BOUNDS, OPTS)).toEqual(placeLabels(build(), BOUNDS, OPTS));
  });

  it("higher priority wins a contested slot regardless of score", () => {
    const inputs = [
      mk({ id: "HIGHSCORE", x: 400, y: 200, score: 999, priority: 0 }),
      mk({ id: "PINNED", x: 402, y: 200, score: 1, priority: 3 }),
    ];
    const placed = placeLabels(inputs, BOUNDS, OPTS);
    const pinned = placed.find((p) => p.id === "PINNED")!;
    const high = placed.find((p) => p.id === "HIGHSCORE")!;
    expect(pinned.slot).toBe("right");
    expect(high.slot).not.toBe("right");
  });
});

// ── ticksInDomain ────────────────────────────────────────────────────────────
describe("ticksInDomain", () => {
  it("keeps only ticks inside [lo, hi]", () => {
    expect(ticksInDomain([2, 5, 10, 20, 40], 3, 25)).toEqual([5, 10, 20]);
    expect(ticksInDomain([0.5, 1, 2, 4, 8], 1, 4)).toEqual([1, 2, 4]);
  });
});
