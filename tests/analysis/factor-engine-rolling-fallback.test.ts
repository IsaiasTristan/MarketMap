/**
 * Tests for the engine-level rolling-window fallback contract.
 *
 * The `runFactorEngine` orchestrator caps the rolling regression window to
 * `Math.min(regressionWindow, n)` so that, when aligned history is a few
 * days short of the requested HORIZON preset (e.g. 484 vs 504), the engine
 * still emits at least one rolling fit. This is what unblocks
 * `computeFactorAttribution` (which gates on `rollingFits.length`) — and
 * therefore unblocks the portfolio Total Return / Variance period waterfalls.
 *
 * The engine itself touches the DB so it is not unit-tested directly; this
 * suite pins the underlying math primitives so the fallback is meaningful.
 */
import { describe, it, expect } from "vitest";
import { rollingMultivariateOls } from "../../src/lib/factors/regression/rolling";
import { minObservations } from "../../src/lib/factors/definitions/model-presets";

function makeDates(n: number): string[] {
  const base = new Date("2024-01-02");
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function seriesWithBeta(n: number, k: number, beta = 0.5, noise = 0.001): {
  y: number[];
  X: number[][];
} {
  // Deterministic sequence — no randomness so the test is stable.
  const X: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: k }, (_, fi) => Math.sin((i + fi) / 5) * 0.01),
  );
  const y = X.map((row, i) =>
    row.reduce((s, x) => s + beta * x, 0) + Math.cos(i / 7) * noise,
  );
  return { y, X };
}

describe("rolling-window fallback contract (engine-rolling-fallback)", () => {
  it("rollingMultivariateOls emits ZERO fits when window > n (motivates the cap)", () => {
    const n = 484;
    const k = 14;
    const requestedWindow = 504; // Long-Term HORIZON preset
    const dates = makeDates(n);
    const { y, X } = seriesWithBeta(n, k);

    const fits = rollingMultivariateOls(dates, y, X, requestedWindow);

    expect(fits).toHaveLength(0);
  });

  it("when the engine caps window to min(requestedWindow, n), rolling fits is non-empty", () => {
    const n = 484;
    const k = 14;
    const requestedWindow = 504;
    const effectiveWindow = Math.min(requestedWindow, n);
    expect(effectiveWindow).toBe(484);

    const dates = makeDates(n);
    const { y, X } = seriesWithBeta(n, k);

    const fits = rollingMultivariateOls(dates, y, X, effectiveWindow);

    expect(fits.length).toBeGreaterThan(0);
    expect(fits.length).toBe(n - effectiveWindow + 1);
    expect(fits[0]!.date).toBe(dates[effectiveWindow - 1]);
    expect(fits[fits.length - 1]!.date).toBe(dates[n - 1]);
  });

  it("effective window never drops below minObservations(k) — rolling enforces it", () => {
    // If the user picks Short-Term (63) but only 30 obs are aligned, the
    // engine still uses min(63, 30) = 30 — but `rollingMultivariateOls`
    // bumps to minObservations(k). Pin that contract so the engine-level
    // cap composes correctly with rolling's internal floor.
    const k = 14;
    const n = 30;
    const requestedWindow = 63;
    const dates = makeDates(n);
    const { y, X } = seriesWithBeta(n, k);

    const fits = rollingMultivariateOls(dates, y, X, Math.min(requestedWindow, n));
    const floor = minObservations(k);

    // When n < minObs the rolling helper produces zero fits — this is the
    // genuine "insufficient data" case the engine returns null on.
    if (n < floor) {
      expect(fits).toHaveLength(0);
    } else {
      expect(fits.length).toBeGreaterThan(0);
    }
  });
});
