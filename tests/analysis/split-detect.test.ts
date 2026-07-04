import { describe, expect, it } from "vitest";
import { detectSplit, type ContinuingHolder } from "@/server/services/institutional/split-detect.service";

/** Build N continuing holders whose shares scale by `shareRatio` and value by
 *  `valueRatio` from a per-fund base (jittered so it's not perfectly uniform). */
function holders(n: number, shareRatio: number, valueRatio: number, jitter = 0): ContinuingHolder[] {
  return Array.from({ length: n }, (_, i) => {
    const prevShares = 1000 + i * 37;
    const prevValue = prevShares * (50 + (i % 5)); // implied price ~ $50
    const sr = shareRatio * (1 + (jitter ? ((i % 3) - 1) * jitter : 0));
    return {
      fundId: `F${i}`,
      prevShares,
      curShares: prevShares * sr,
      prevValue,
      curValue: prevValue * valueRatio,
    };
  });
}

describe("split detector", () => {
  it("detects a 2:1 split (shares double, value ~unchanged) with derived ratio 2", () => {
    // Value conserved: price halves. 12 holders all doubling shares.
    const hs = holders(12, 2, 1.0);
    const v = detectSplit(hs);
    expect(v.kind).toBe("split");
    if (v.kind === "split") {
      expect(v.ratio).toBe(2);
      expect(v.nFunds).toBe(12);
      expect(v.confidence).toBeGreaterThan(0.9);
    }
  });

  it("detects a 1:2 reverse split (shares halve, value ~unchanged)", () => {
    const hs = holders(8, 0.5, 1.0);
    const v = detectSplit(hs);
    expect(v.kind).toBe("split");
    if (v.kind === "split") expect(v.ratio).toBe(0.5);
  });

  it("does NOT flag genuine 4x accumulation (shares 4x AND value 4x, price flat) — real adders, no hold", () => {
    // grossReturn = medPriceRatio·R = 1·4 = 4 (implausible), but price is flat
    // (value scaled with shares) ⇒ real coordinated accumulation, NOT a split.
    const hs = holders(10, 4, 4);
    const v = detectSplit(hs);
    expect(v.kind).toBe("none");
  });

  it("never fires on a crash quarter (shares unchanged, prices fall 60%)", () => {
    // Continuing holders keep identical shares → ratio 1 → inside no-change band.
    const hs = holders(15, 1.0, 0.4);
    const v = detectSplit(hs);
    expect(v.kind).toBe("none");
  });

  it("holds (UNRESOLVED) when the share ratio is split-like but the price fingerprint is ambiguous", () => {
    // Shares double AND price rises 50% (value = 2·1.5 = 3x). grossReturn = 1.5·2 = 3
    // (implausible) and price is NOT flat ⇒ ambiguous → data hold, never guess.
    const hs = holders(10, 2, 3);
    const v = detectSplit(hs);
    expect(v.kind).toBe("unresolved");
  });

  it("does not fire with too few funds (< min_funds)", () => {
    const hs = holders(3, 2, 1.0);
    const v = detectSplit(hs);
    expect(v.kind).toBe("none");
  });

  it("holds when only ~60% of holders share the ratio (weak coordination)", () => {
    // 6 of 10 double; 4 unchanged → agreement 0.6, below 0.7 super-majority.
    const doublers = holders(6, 2, 1.0);
    const flat = holders(4, 1.0, 1.0).map((h) => ({ ...h, fundId: `G${h.fundId}` }));
    const v = detectSplit([...doublers, ...flat]);
    expect(v.kind).toBe("unresolved");
  });

  it("is deterministic — same input, same verdict", () => {
    const hs = holders(12, 2, 1.0);
    expect(detectSplit(hs)).toEqual(detectSplit(hs));
  });
});
