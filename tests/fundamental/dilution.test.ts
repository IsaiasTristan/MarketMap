import { describe, expect, it } from "vitest";
import { dilutionComponents } from "@/lib/fundamental/dilution";

describe("dilutionComponents", () => {
  // 9 quarters oldest -> newest; shares flat then rising (dilution).
  const sharesRising = [100, 100, 100, 100, 105, 108, 110, 112, 115];
  it("penalises diluted-share growth (negative quality)", () => {
    const c = dilutionComponents({
      dilutedShares: sharesRising,
      commonStockIssuedTtm: 50,
      commonStockRepurchasedTtm: 0,
      sbcTtm: 30,
      revenueTtm: 1000,
      avgMarketCap: 10_000,
    });
    expect(c.shareGrowthQuality!).toBeLessThan(0); // shares grew YoY
    expect(c.shareCagr2yQuality!).toBeLessThan(0);
    expect(c.netIssuanceQuality!).toBeLessThan(0); // net issuance => dilution
    expect(c.sbcQuality!).toBeCloseTo(-0.03, 9); // -(30/1000)
  });
  it("rewards net buybacks (positive net-issuance quality)", () => {
    const c = dilutionComponents({
      dilutedShares: [100, 100, 99, 98, 97, 96, 95, 94, 93],
      commonStockIssuedTtm: 10,
      commonStockRepurchasedTtm: -60, // FMP-negative
      sbcTtm: 5,
      revenueTtm: 1000,
      avgMarketCap: 5_000,
    });
    expect(c.shareGrowthQuality!).toBeGreaterThan(0); // shares shrank => good
    expect(c.netIssuanceQuality!).toBeGreaterThan(0); // net buyback => good
  });
  it("nulls net issuance when market cap is missing/zero", () => {
    const c = dilutionComponents({
      dilutedShares: sharesRising,
      commonStockIssuedTtm: 50,
      commonStockRepurchasedTtm: 0,
      sbcTtm: 30,
      revenueTtm: 1000,
      avgMarketCap: 0,
    });
    expect(c.netIssuanceQuality).toBeNull();
  });
});
