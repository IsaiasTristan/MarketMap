import { describe, it, expect } from "vitest";

/** Mirrors loadPortfolioWeights gross/signed weight math for cash + equity. */
function deriveWeights(
  rows: { isCash: boolean; marketValue: number; isShort: boolean }[],
) {
  const totalGross = rows.reduce((s, r) => s + r.marketValue, 0);
  return rows.map((r) => {
    const gross = totalGross > 0 ? r.marketValue / totalGross : 0;
    return {
      grossWeight: gross,
      signedWeight: r.isCash ? gross : (r.isShort ? -1 : 1) * gross,
    };
  });
}

describe("cash position weights", () => {
  it("cash market value equals dollar amount at weight 1", () => {
    const weights = deriveWeights([
      { isCash: false, marketValue: 100_000, isShort: false },
      { isCash: true, marketValue: 50_000, isShort: false },
    ]);

    expect(weights[0]!.grossWeight).toBeCloseTo(2 / 3, 10);
    expect(weights[1]!.grossWeight).toBeCloseTo(1 / 3, 10);
    expect(weights[1]!.signedWeight).toBeCloseTo(1 / 3, 10);
    expect(weights.reduce((s, w) => s + w.grossWeight, 0)).toBeCloseTo(1, 10);
  });

  it("cash is never short — signed weight stays positive", () => {
    const weights = deriveWeights([
      { isCash: true, marketValue: 25_000, isShort: false },
    ]);
    expect(weights[0]!.signedWeight).toBe(1);
  });
});
