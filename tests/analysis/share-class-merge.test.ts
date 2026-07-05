import { describe, expect, it } from "vitest";
import {
  canonicalTicker,
  isNonCanonicalClass,
  mergeShareClassPositions,
  SHARE_CLASS_CANONICAL,
  type MergeablePosition,
} from "@/lib/institutional/share-class-merge";

describe("canonicalTicker", () => {
  it("folds a non-canonical class into its surviving sibling", () => {
    expect(canonicalTicker("GOOG")).toBe("GOOGL");
    expect(canonicalTicker("FOX")).toBe("FOXA");
  });
  it("is idempotent — the canonical symbol maps to itself", () => {
    expect(canonicalTicker("GOOGL")).toBe("GOOGL");
    expect(canonicalTicker("FOXA")).toBe("FOXA");
    expect(canonicalTicker(canonicalTicker("GOOG"))).toBe("GOOGL");
  });
  it("leaves unmapped tickers untouched (case/space-normalized)", () => {
    expect(canonicalTicker(" aapl ")).toBe("AAPL");
    expect(canonicalTicker("MSFT")).toBe("MSFT");
  });
  it("folds the hyphen-form dual classes (DB ticker form)", () => {
    expect(canonicalTicker("BRK-A")).toBe("BRK-B");
    expect(canonicalTicker("LEN-B")).toBe("LEN");
    expect(canonicalTicker("HEI-A")).toBe("HEI");
    expect(canonicalTicker("MKC-V")).toBe("MKC");
  });
  it("leaves dot-form and preferred/ADR symbols unmapped (economically distinct)", () => {
    expect(canonicalTicker("BRK.A")).toBe("BRK.A"); // dot form is not the DB ticker
    expect(canonicalTicker("PBR-A")).toBe("PBR-A"); // preferred ADR, deliberately excluded
  });
  it("isNonCanonicalClass is true only for the folded-away symbols", () => {
    expect(isNonCanonicalClass("GOOG")).toBe(true);
    expect(isNonCanonicalClass("BRK-A")).toBe(true);
    expect(isNonCanonicalClass("GOOGL")).toBe(false);
    expect(isNonCanonicalClass("BRK-B")).toBe(false);
    expect(isNonCanonicalClass("AAPL")).toBe(false);
  });
});

describe("mergeShareClassPositions", () => {
  const mk = (ticker: string, shares: number, value: number): MergeablePosition => ({ ticker, shares, value });

  it("folds a fund holding both classes into one canonical position, summing shares+value", () => {
    const merged = mergeShareClassPositions([mk("GOOGL", 100, 15_000), mk("GOOG", 60, 9_000), mk("AAPL", 200, 40_000)]);
    const goog = merged.find((m) => m.ticker === "GOOGL")!;
    expect(goog.shares).toBe(160);
    expect(goog.value).toBe(24_000);
    expect(goog.mergedFrom).toEqual(["GOOG"]);
    expect(goog.sources).toHaveLength(2);
    // Untouched name passes through with no merge provenance.
    const aapl = merged.find((m) => m.ticker === "AAPL")!;
    expect(aapl.mergedFrom).toEqual([]);
    expect(aapl.shares).toBe(200);
  });

  it("renames a lone non-canonical holding (fund holds only GOOG) to the canonical ticker", () => {
    const merged = mergeShareClassPositions([mk("GOOG", 50, 7_500)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.ticker).toBe("GOOGL");
    expect(merged[0]!.shares).toBe(50);
    expect(merged[0]!.mergedFrom).toEqual(["GOOG"]);
  });

  it("leaves a book with no dual-class names unchanged (no spurious merges)", () => {
    const merged = mergeShareClassPositions([mk("MSFT", 10, 1_000), mk("NVDA", 5, 900)]);
    expect(merged.map((m) => m.ticker)).toEqual(["MSFT", "NVDA"]);
    expect(merged.every((m) => m.mergedFrom.length === 0)).toBe(true);
  });

  it("is deterministic — canonical rows sorted by ticker, idempotent on re-merge", () => {
    const once = mergeShareClassPositions([mk("GOOG", 60, 9_000), mk("GOOGL", 100, 15_000), mk("FOX", 5, 250), mk("FOXA", 7, 350)]);
    expect(once.map((m) => m.ticker)).toEqual(["FOXA", "GOOGL"]);
    // Re-merging the already-canonical output changes nothing (idempotent).
    const twice = mergeShareClassPositions(once.map((m) => ({ ticker: m.ticker, shares: m.shares, value: m.value })));
    expect(twice.map((m) => [m.ticker, m.shares, m.value])).toEqual(once.map((m) => [m.ticker, m.shares, m.value]));
    expect(twice.every((m) => m.mergedFrom.length === 0)).toBe(true);
  });

  it("handles non-finite shares/value defensively (treated as 0)", () => {
    const merged = mergeShareClassPositions([mk("GOOGL", NaN, 15_000), mk("GOOG", 60, Infinity)]);
    const goog = merged.find((m) => m.ticker === "GOOGL")!;
    expect(goog.shares).toBe(60); // no canonical price → falls back to fold shares
    expect(goog.value).toBe(15_000);
  });

  it("expresses a non-parity fold (BRK-A into BRK-B) in canonical-class share units", () => {
    // BRK-B: 100 sh @ $300 = $30k ; BRK-A: 2 sh @ $450k = $900k. Naive sum (102) is
    // nonsense; canonical-unit shares = $930k / $300 = 3100 B-equivalent shares.
    const merged = mergeShareClassPositions([mk("BRK-B", 100, 30_000), mk("BRK-A", 2, 900_000)]);
    const brk = merged.find((m) => m.ticker === "BRK-B")!;
    expect(brk.value).toBe(930_000);
    expect(brk.shares).toBeCloseTo(3100, 5);
    expect(brk.mergedFrom).toEqual(["BRK-A"]);
  });

  it("near-parity fold (GOOG into GOOGL) still equals the summed share count", () => {
    // both classes priced at $150 → value-basis and share-sum agree.
    const merged = mergeShareClassPositions([mk("GOOGL", 100, 15_000), mk("GOOG", 60, 9_000)]);
    expect(merged[0]!.shares).toBe(160);
  });

  it("the canonical map is curated dual-class pairs only (no preferred/ADR)", () => {
    // every value is a real surviving ticker; no key maps to itself
    for (const [from, to] of Object.entries(SHARE_CLASS_CANONICAL)) expect(from).not.toBe(to);
    expect(SHARE_CLASS_CANONICAL["BRK-A"]).toBe("BRK-B");
    expect(SHARE_CLASS_CANONICAL["PBR-A"]).toBeUndefined();
  });
});
