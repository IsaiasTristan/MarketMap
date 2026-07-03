import { describe, it, expect } from "vitest";
import { placeLabels, type LabelInput, type PlotBounds, type PlaceOpts, type PlacedLabel } from "@/components/analysis/flows/quadrant/labelPlacement";

const BOUNDS: PlotBounds = { x0: 0, y0: 0, x1: 800, y1: 400 };
const OPTS: PlaceOpts = { fontSize: 10, charWidth: 6, pad: 2, slots: ["right", "above-right", "below-right", "left"] };

function mk(over: Partial<LabelInput> & { id: string }): LabelInput {
  return { x: 100, y: 100, r: 5, text: over.id, score: 1, forced: false, ...over };
}

function rectsOverlap(a: PlacedLabel, b: PlacedLabel): boolean {
  return a.rect.x < b.rect.x + b.rect.w && a.rect.x + a.rect.w > b.rect.x && a.rect.y < b.rect.y + b.rect.h && a.rect.y + a.rect.h > b.rect.y;
}

describe("placeLabels", () => {
  it("returns nothing for empty input", () => {
    expect(placeLabels([], BOUNDS, OPTS)).toEqual([]);
  });

  it("places a lone label in the first slot (right)", () => {
    const [p] = placeLabels([mk({ id: "AAA", x: 400, y: 200 })], BOUNDS, OPTS);
    expect(p!.slot).toBe("right");
    expect(p!.anchor).toBe("start");
    expect(p!.x).toBeGreaterThan(400); // to the right of the mark
  });

  it("gives vertically-stacked points non-overlapping labels via fallback slots", () => {
    // Two marks stacked vertically: neither mark blocks the other's 'right'
    // slot, but their 'right' labels would collide — so the higher-score one
    // takes 'right' and the other falls back.
    const inputs = [
      mk({ id: "HI", x: 400, y: 200, score: 10 }),
      mk({ id: "LO", x: 400, y: 208, score: 1 }),
    ];
    const placed = placeLabels(inputs, BOUNDS, OPTS);
    expect(placed).toHaveLength(2);
    const hi = placed.find((p) => p.id === "HI")!;
    const lo = placed.find((p) => p.id === "LO")!;
    expect(hi.slot).toBe("right");
    expect(lo.slot).not.toBe("right");
    expect(rectsOverlap(hi, lo)).toBe(false);
  });

  it("no placed labels overlap each other in a moderate cluster", () => {
    const inputs = Array.from({ length: 12 }, (_, i) =>
      mk({ id: `T${i}`, x: 300 + (i % 4) * 12, y: 180 + Math.floor(i / 4) * 12, score: 12 - i }),
    );
    const placed = placeLabels(inputs, BOUNDS, OPTS);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(rectsOverlap(placed[i]!, placed[j]!)).toBe(false);
      }
    }
  });

  it("drops the lowest-score labels when a tight cluster cannot fit them all", () => {
    // Pack many long labels into a tiny plot so some cannot be placed.
    const tiny: PlotBounds = { x0: 0, y0: 0, x1: 120, y1: 120 };
    const inputs = Array.from({ length: 10 }, (_, i) =>
      mk({ id: `N${i}`, x: 60, y: 60, r: 6, text: "LONGNAME", score: 100 - i * 10 }),
    );
    const placed = placeLabels(inputs, tiny, OPTS);
    expect(placed.length).toBeLessThan(inputs.length);
    // Everything placed outscores everything dropped.
    const placedIds = new Set(placed.map((p) => p.id));
    const minPlacedScore = Math.min(...inputs.filter((i) => placedIds.has(i.id)).map((i) => i.score));
    const maxDroppedScore = Math.max(...inputs.filter((i) => !placedIds.has(i.id)).map((i) => i.score));
    expect(minPlacedScore).toBeGreaterThanOrEqual(maxDroppedScore);
  });

  it("falls back to the left slot for a point on the right edge", () => {
    // Mark hard against the right boundary: all right-facing slots exit bounds.
    const [p] = placeLabels([mk({ id: "EDGE", x: 798, y: 200, text: "EDGE" })], BOUNDS, OPTS);
    expect(p!.slot).toBe("left");
    expect(p!.anchor).toBe("end");
    expect(p!.rect.x).toBeGreaterThanOrEqual(BOUNDS.x0);
  });

  it("ranks forced (danger-zone) labels ahead of higher-score normal labels for a contested slot", () => {
    // Both want 'right' at the same spot; the forced (lower-score) one wins it.
    const inputs = [
      mk({ id: "NORMAL", x: 400, y: 200, score: 999, forced: false }),
      mk({ id: "DANGER", x: 402, y: 200, score: 1, forced: true }),
    ];
    const placed = placeLabels(inputs, BOUNDS, OPTS);
    const danger = placed.find((p) => p.id === "DANGER")!;
    const normal = placed.find((p) => p.id === "NORMAL")!;
    expect(danger.slot).toBe("right");
    expect(normal.slot).not.toBe("right");
    expect(rectsOverlap(danger, normal)).toBe(false);
  });

  it("is deterministic — identical inputs produce identical output", () => {
    const build = () =>
      Array.from({ length: 15 }, (_, i) => mk({ id: `D${i}`, x: 200 + (i % 5) * 15, y: 150 + (i % 3) * 15, score: (i * 7) % 11 }));
    expect(placeLabels(build(), BOUNDS, OPTS)).toEqual(placeLabels(build(), BOUNDS, OPTS));
  });
});
