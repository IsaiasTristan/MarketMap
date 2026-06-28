import { describe, expect, it } from "vitest";
import { BOX_REGISTRY, MIN_VALID_BOXES, flatKey, type BoxKey } from "@/lib/fundamental/boxes";
import { computeBoxScores } from "@/lib/fundamental/box-scoring";

/** Build a full flat component map (every registry key) from a per-ticker offset. */
function fullComponents(offset: number, skipBoxes: BoxKey[] = []): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const box of BOX_REGISTRY) {
    for (const c of box.components) {
      m[flatKey(box.key, c.key)] = skipBoxes.includes(box.key) ? null : offset + c.key.length * 0.01;
    }
  }
  return m;
}

describe("computeBoxScores", () => {
  it("produces a composite from >= MIN_VALID_BOXES boxes and ranks within a peer group", () => {
    const components = [fullComponents(1), fullComponents(2), fullComponents(3), fullComponents(4)];
    const peerKeys = ["G", "G", "G", "G"];
    const res = computeBoxScores({ components, peerKeys });

    for (const r of res) {
      expect(r.validBoxCount).toBe(BOX_REGISTRY.length); // all 9 boxes valid
      expect(r.composite).not.toBeNull();
    }
    // Higher offset => higher components => higher composite.
    expect(res[3]!.composite!).toBeGreaterThan(res[0]!.composite!);
  });

  it("box score equals the mean of its component peer z-scores", () => {
    const components = [fullComponents(1), fullComponents(2), fullComponents(3)];
    const res = computeBoxScores({ components, peerKeys: ["G", "G", "G"] });
    const box = BOX_REGISTRY[0]!;
    const zs = box.components.map((c) => res[0]!.componentZ[flatKey(box.key, c.key)]!);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    expect(res[0]!.boxScores[box.key]!).toBeCloseTo(mean, 12);
  });

  it("nulls the composite when fewer than MIN_VALID_BOXES boxes are valid", () => {
    // Drop 2 boxes for the first ticker -> 7 valid < 8.
    const skip: BoxKey[] = [BOX_REGISTRY[7]!.key, BOX_REGISTRY[8]!.key];
    const components = [
      fullComponents(1, skip),
      fullComponents(2),
      fullComponents(3),
      fullComponents(4),
    ];
    const res = computeBoxScores({ components, peerKeys: ["G", "G", "G", "G"] });
    expect(res[0]!.validBoxCount).toBe(BOX_REGISTRY.length - 2);
    expect(MIN_VALID_BOXES).toBe(8);
    expect(res[0]!.composite).toBeNull();
    expect(res[1]!.composite).not.toBeNull();
  });

  it("z-scores each peer group independently", () => {
    const components = [fullComponents(1), fullComponents(2), fullComponents(100), fullComponents(101)];
    const res = computeBoxScores({ components, peerKeys: ["A", "A", "B", "B"] });
    // Within each group the lower-offset name is the laggard (negative composite).
    expect(res[0]!.composite!).toBeLessThan(res[1]!.composite!);
    expect(res[2]!.composite!).toBeLessThan(res[3]!.composite!);
    // Group B's huge raw level does not make it dominate group A's z-scores.
    expect(res[3]!.composite!).toBeCloseTo(res[1]!.composite!, 6);
  });

  it("is deterministic / idempotent for identical inputs", () => {
    const components = [fullComponents(1), fullComponents(2), fullComponents(3)];
    const peerKeys = ["G", "G", "G"];
    const a = computeBoxScores({ components, peerKeys });
    const b = computeBoxScores({ components, peerKeys });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("emits an audit with raw + z for every component and a missing reason", () => {
    const components = [fullComponents(1), fullComponents(2)];
    const res = computeBoxScores({ components, peerKeys: ["G", "G"] });
    const firstBox = res[0]!.boxes[0]!;
    expect(firstBox.components.length).toBe(BOX_REGISTRY[0]!.components.length);
    expect(firstBox.components[0]).toHaveProperty("raw");
    expect(firstBox.components[0]).toHaveProperty("z");
    expect(firstBox.missingReason).toBeNull();
  });
});
