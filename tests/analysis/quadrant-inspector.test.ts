import { describe, it, expect } from "vitest";
import { classifyGesture, normalizeRect, dragDistance } from "@/components/analysis/flows/quadrant/gesture";
import { classifyZone, ZONE_ORDER } from "@/components/analysis/flows/quadrant/zones";
import { deriveInspectorRows, aggregateNetFlow } from "@/components/analysis/flows/quadrant/inspectorRows";
import type { PlottedPoint, QuadrantModel } from "@/components/analysis/flows/quadrant/quadrantModel";

// ── gesture ────────────────────────────────────────────────────────────────
describe("classifyGesture", () => {
  const base = { shiftKey: false, spaceKey: false, onMark: false, zoomed: false };
  it("shift always brushes", () => {
    expect(classifyGesture({ ...base, shiftKey: true })).toBe("brush");
    expect(classifyGesture({ ...base, shiftKey: true, onMark: true, spaceKey: true, zoomed: true })).toBe("brush");
  });
  it("space pans only when zoomed", () => {
    expect(classifyGesture({ ...base, spaceKey: true, zoomed: true })).toBe("pan");
    expect(classifyGesture({ ...base, spaceKey: true, zoomed: false })).toBe("select");
  });
  it("press on a mark is a click", () => {
    expect(classifyGesture({ ...base, onMark: true })).toBe("click");
  });
  it("press on empty canvas selects", () => {
    expect(classifyGesture(base)).toBe("select");
  });
});

describe("normalizeRect / dragDistance", () => {
  it("normalizes any drag direction to x0≤x1, y0≤y1", () => {
    expect(normalizeRect({ x: 150, y: 150 }, { x: 0, y: 0 })).toEqual({ x0: 0, y0: 0, x1: 150, y1: 150 });
    expect(normalizeRect({ x: 0, y: 150 }, { x: 150, y: 0 })).toEqual({ x0: 0, y0: 0, x1: 150, y1: 150 });
  });
  it("distance is symmetric", () => {
    expect(dragDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(dragDistance({ x: 3, y: 4 }, { x: 0, y: 0 })).toBe(5);
  });
});

// ── zones ──────────────────────────────────────────────────────────────────
describe("classifyZone", () => {
  const p75b = 10;
  const p75c = 2;
  it("high conviction + low breadth → emerging", () => {
    expect(classifyZone(5, 4, p75b, p75c)).toBe("emerging");
  });
  it("high conviction + high breadth → crowded", () => {
    expect(classifyZone(20, 4, p75b, p75c)).toBe("crowded");
  });
  it("low conviction + low breadth → toe-dipping", () => {
    expect(classifyZone(5, 1, p75b, p75c)).toBe("toe-dipping");
  });
  it("low conviction + high breadth → below-median", () => {
    expect(classifyZone(20, 1, p75b, p75c)).toBe("below-median");
  });
  it("null conviction counts as low; boundary is the low side", () => {
    expect(classifyZone(5, null, p75b, p75c)).toBe("toe-dipping");
    expect(classifyZone(10, 2, p75b, p75c)).toBe("toe-dipping"); // == both boundaries → low/low
  });
  it("ZONE_ORDER lists all four zones once", () => {
    expect(new Set(ZONE_ORDER).size).toBe(4);
  });
});

// ── inspector rows ───────────────────────────────────────────────────────────
function mkPoint(over: Partial<PlottedPoint> & { ticker: string }): PlottedPoint {
  return {
    ticker: over.ticker,
    companyName: over.companyName ?? over.ticker,
    sector: null,
    marketCapTier: null,
    breadth: over.breadth ?? 5,
    conviction: "conviction" in over ? over.conviction ?? null : 1,
    deltaHolders: over.deltaHolders ?? 0,
    holderStreak: over.holderStreak ?? 0,
    fundsHolding: over.fundsHolding ?? 5,
    fundsBought: 0,
    fundsSold: 0,
    quadrant: over.quadrant ?? null,
    trajectoryLabel: over.trajectoryLabel ?? null,
    prev: over.prev ?? null,
    layer: over.layer ?? "background",
    r: over.r ?? 3,
    fill: over.fill ?? "#888",
    score: over.score ?? 0,
    danger: over.danger ?? false,
  };
}

function mkModel(fg: PlottedPoint[], bg: PlottedPoint[], over: Partial<QuadrantModel> = {}): QuadrantModel {
  return {
    foreground: fg,
    background: bg,
    p75Breadth: over.p75Breadth ?? 10,
    p75Conviction: over.p75Conviction ?? 2,
    xDomain: [1, 40],
    yDomain: [0.3, 8],
    xTicks: [],
    yTicks: [],
    breadthLine: over.breadthLine ?? 8,
    convictionLine: over.convictionLine ?? 1.5,
    trackedFunds: over.trackedFunds ?? 100,
  };
}

describe("deriveInspectorRows", () => {
  const fg = [
    mkPoint({ ticker: "HIGH", conviction: 4, breadth: 5, layer: "foreground", deltaHolders: 6 }),
    mkPoint({ ticker: "MID", conviction: 1.5, breadth: 20, layer: "foreground", deltaHolders: -3 }),
  ];
  const bg = [
    mkPoint({ ticker: "CTX", conviction: 0.8, breadth: 3, layer: "background" }),
    mkPoint({ ticker: "GUT", conviction: 0.1, breadth: 2, layer: "background" }), // below range
    mkPoint({ ticker: "NULLC", conviction: null, breadth: 4, layer: "background" }), // below range
  ];
  const model = mkModel(fg, bg);
  const FLOOR = 0.3;

  it("sorts by conviction desc, nulls last, ticker tiebreak", () => {
    const rows = deriveInspectorRows(["HIGH", "MID", "CTX", "GUT", "NULLC"], model, FLOOR);
    expect(rows.map((r) => r.ticker)).toEqual(["HIGH", "MID", "CTX", "GUT", "NULLC"]);
  });

  it("tags layers correctly incl. below range for gutter names", () => {
    const rows = deriveInspectorRows(["HIGH", "CTX", "GUT", "NULLC"], model, FLOOR);
    const byT = new Map(rows.map((r) => [r.ticker, r.layer]));
    expect(byT.get("HIGH")).toBe("foreground");
    expect(byT.get("CTX")).toBe("context");
    expect(byT.get("GUT")).toBe("below range");
    expect(byT.get("NULLC")).toBe("below range");
  });

  it("ignores tickers absent from the model", () => {
    const rows = deriveInspectorRows(["HIGH", "GHOST"], model, FLOOR);
    expect(rows.map((r) => r.ticker)).toEqual(["HIGH"]);
  });

  it("is stable regardless of input ticker order (survives zoom re-derivation)", () => {
    const a = deriveInspectorRows(["GUT", "MID", "HIGH", "CTX"], model, FLOOR);
    const b = deriveInspectorRows(["HIGH", "CTX", "GUT", "MID"], model, FLOOR);
    expect(a).toEqual(b);
  });

  it("aggregateNetFlow sums Δholders", () => {
    const rows = deriveInspectorRows(["HIGH", "MID"], model, FLOOR);
    expect(aggregateNetFlow(rows)).toBe(3); // 6 + (-3)
  });
});
