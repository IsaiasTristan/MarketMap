import { describe, expect, it } from "vitest";
import { neweyWestBandwidth, neweyWestMeanSe } from "@/lib/factors/regression/hac";

describe("neweyWestBandwidth", () => {
  it("matches the Newey-West (1994) plug-in formula on representative sample sizes", () => {
    // L = floor(4 · (n/100)^(2/9))
    expect(neweyWestBandwidth(60)).toBe(Math.max(1, Math.min(59, Math.floor(4 * Math.pow(0.6, 2 / 9)))));
    expect(neweyWestBandwidth(252)).toBe(Math.max(1, Math.min(251, Math.floor(4 * Math.pow(2.52, 2 / 9)))));
    expect(neweyWestBandwidth(1000)).toBe(Math.max(1, Math.min(999, Math.floor(4 * Math.pow(10, 2 / 9)))));
  });

  it("floors at 1 (no silent OLS degradation) and caps at n-1", () => {
    expect(neweyWestBandwidth(2)).toBe(1);
    expect(neweyWestBandwidth(1)).toBe(1);
    expect(neweyWestBandwidth(0)).toBe(1);
  });
});

describe("neweyWestMeanSe", () => {
  it("recovers the OLS SE under iid noise (HAC ≈ σ/√n)", () => {
    // Construct n=400 iid-ish series; HAC and OLS should be close (within
    // ~10 % at L≈4-5, dominated by γ_0 since γ_j ≈ 0 for j > 0 in iid).
    const n = 400;
    const series: number[] = [];
    let seed = 1;
    for (let i = 0; i < n; i++) {
      // deterministic LCG so the test is reproducible
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      series.push((seed / 0x7fffffff) - 0.5);
    }
    const r = neweyWestMeanSe(series);
    const olsVar = series.reduce((s, v) => s + (v - r.mean) ** 2, 0) / n;
    const olsSe = Math.sqrt(olsVar / n);
    // Expect HAC within 25 % of OLS for iid (the Bartlett tails contribute a small
    // amount of noise from finite-lag autocovariances). Tight enough to catch a
    // dropped factor of n or √n, loose enough to not be flaky.
    expect(r.hacSe / olsSe).toBeGreaterThan(0.75);
    expect(r.hacSe / olsSe).toBeLessThan(1.25);
  });

  it("inflates SE relative to OLS under positive autocorrelation (AR(1) ρ=0.7)", () => {
    const n = 400;
    const rho = 0.7;
    const series: number[] = [];
    let prev = 0;
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const eps = (seed / 0x7fffffff) - 0.5;
      const v = rho * prev + eps;
      series.push(v);
      prev = v;
    }
    const r = neweyWestMeanSe(series);
    const olsVar = series.reduce((s, v) => s + (v - r.mean) ** 2, 0) / n;
    const olsSe = Math.sqrt(olsVar / n);
    // The point of HAC: autocorrelation should make SE meaningfully larger
    // than the naive OLS SE. For AR(1) with ρ=0.7 the long-run variance
    // ratio is (1+ρ)/(1−ρ) ≈ 5.7, so √5.7 ≈ 2.4× SE inflation in the limit;
    // finite L undershoots that, but we should see clear lift.
    expect(r.hacSe).toBeGreaterThan(olsSe * 1.4);
  });

  it("returns hacSe=0 on n=1 (degenerate sample)", () => {
    expect(neweyWestMeanSe([3.14])).toEqual({ mean: 3.14, hacSe: 0, bandwidth: 0, n: 1 });
  });

  it("clips negative long-run variance to zero rather than NaN", () => {
    // Strongly negatively autocorrelated +1, -1 alternating series. The
    // Bartlett-kernel sum can go slightly negative on small n; we just
    // need a finite hacSe.
    const series = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1];
    const r = neweyWestMeanSe(series);
    expect(Number.isFinite(r.hacSe)).toBe(true);
    expect(r.hacSe).toBeGreaterThanOrEqual(0);
  });
});
