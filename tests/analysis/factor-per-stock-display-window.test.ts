/**
 * factor-per-stock-display-window — 2026-04-26 lock.
 *
 * Pure-math regression coverage for the per-stock timeseries display-window
 * contract introduced when the rolling charts were fixed to render a full
 * set of valid rolling observations:
 *
 *   • `burnInIndex = effectiveWindow - 1`
 *   • `displayStartIndex = max(burnInIndex, n - params.window)`
 *   • When `n >= params.window + effectiveWindow`:
 *       - visible region length == params.window
 *       - every visible day carries a non-failed rolling fit
 *       - the burn-in cutoff falls BEFORE the visible region (so the UI
 *         does not need to draw a burn-in overlay).
 *   • When `n < params.window + effectiveWindow` (short-history fallback):
 *       - visible region begins at burnInIndex (UI grey-overlays burn-in)
 *
 * Snapshot tie-out: when rolling W = display W and the loaded series spans
 * `display W + rolling W + buffer`, the LATEST rolling fit still equals the
 * snapshot fit on the last `params.window` observations to FP precision.
 */
import { describe, it, expect } from "vitest";
import { multivariateOls } from "../../src/lib/factors/regression/ols";
import { rollingMultivariateOls } from "../../src/lib/factors/regression/rolling";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}

function makeSeries(n: number, k: number, seed: number) {
  const r = rng(seed);
  const X: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: k }, () => r() * 0.02),
  );
  const trueBetas = [0.7, -0.4, 0.5, 0.2, -0.1].slice(0, k);
  const y = X.map((row) => {
    let s = r() * 0.005;
    for (let j = 0; j < k; j++) s += (trueBetas[j] ?? 0) * (row[j] ?? 0);
    return s;
  });
  const dates = Array.from({ length: n }, (_, i) => {
    const day = (i % 28) + 1;
    const month = ((Math.floor(i / 28) % 12) + 1);
    const year = 2010 + Math.floor(i / 336);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
  return { X, y, dates };
}

/** Mirrors factor-per-stock-timeseries.service derivation. */
function deriveIndices(
  n: number,
  paramsWindow: number,
  effectiveWindow: number,
) {
  const burnInIndex = effectiveWindow - 1;
  const displayStartIndex = Math.max(burnInIndex, n - paramsWindow);
  return { burnInIndex, displayStartIndex };
}

describe("per-stock timeseries display-window contract (2026-04-26)", () => {
  it("extended history → visible region is fully populated with valid rolling fits", () => {
    const paramsWindow = 252;
    const rollingWindow = 252;
    const dataBuffer = 20;
    // requiredHistory = display + rolling + buffer
    const requiredHistory = paramsWindow + rollingWindow + dataBuffer;
    const { X, y, dates } = makeSeries(requiredHistory, 3, 17);

    const fits = rollingMultivariateOls(dates, y, X, rollingWindow);
    expect(fits.length).toBe(requiredHistory - rollingWindow + 1);
    for (const f of fits) expect(f.fit.failed).toBe(false);

    const { burnInIndex, displayStartIndex } = deriveIndices(
      requiredHistory,
      paramsWindow,
      rollingWindow,
    );
    expect(burnInIndex).toBe(rollingWindow - 1);
    expect(displayStartIndex).toBe(requiredHistory - paramsWindow);
    // Burn-in is BEFORE the visible region (no overlay needed).
    expect(burnInIndex).toBeLessThan(displayStartIndex);

    // Every visible day has a rolling fit.
    const visibleObs = requiredHistory - displayStartIndex;
    expect(visibleObs).toBe(paramsWindow);
    for (let i = displayStartIndex; i < requiredHistory; i++) {
      const r = i - burnInIndex;
      expect(fits[r]).toBeDefined();
      expect(fits[r]!.fit.failed).toBe(false);
    }
  });

  it("short history (n < display + rolling) → visible region starts at burn-in cutoff", () => {
    const paramsWindow = 400;
    const rollingWindow = 252;
    // n = 350 ⇒ shorter than display + rolling but plenty of rolling fits.
    const n = 350;
    const { X, y, dates } = makeSeries(n, 3, 19);

    const fits = rollingMultivariateOls(dates, y, X, rollingWindow);
    expect(fits.length).toBeGreaterThan(0);

    const { burnInIndex, displayStartIndex } = deriveIndices(
      n,
      paramsWindow,
      rollingWindow,
    );
    expect(burnInIndex).toBe(rollingWindow - 1);
    // n - paramsWindow < burnInIndex ⇒ displayStartIndex falls back to burn-in.
    expect(displayStartIndex).toBe(burnInIndex);
    // UI must overlay burn-in only when burnInIndex > displayStartIndex —
    // here they are equal so no overlay is required.
  });

  it("snapshot tie-out — latest rolling fit on extended history matches snapshot OLS on last paramsWindow obs", () => {
    const paramsWindow = 252;
    const rollingWindow = 252;
    const dataBuffer = 20;
    const n = paramsWindow + rollingWindow + dataBuffer;
    const k = 3;
    const { X, y, dates } = makeSeries(n, k, 23);

    // Snapshot: fit on the last paramsWindow observations.
    const snap = multivariateOls(y.slice(-paramsWindow), X.slice(-paramsWindow));
    expect(snap.failed).toBe(false);

    // Rolling: identical W; latest fit ends at last index of extended history.
    const fits = rollingMultivariateOls(dates, y, X, rollingWindow);
    const last = fits[fits.length - 1]!.fit;
    expect(last.failed).toBe(false);

    // Snapshot uses the last `paramsWindow` rows; the latest rolling fit
    // uses the last `rollingWindow` rows. With paramsWindow == rollingWindow
    // they are the SAME sample, so betas tie to FP precision.
    for (let i = 0; i < k; i++) {
      expect(last.betas[i]).toBeCloseTo(snap.betas[i] ?? 0, 12);
    }
    expect(last.alpha).toBeCloseTo(snap.alpha, 12);
    expect(last.rSquared).toBeCloseTo(snap.rSquared, 12);
  });

  it("visible obs count formula: max(0, n - displayStartIndex) == min(paramsWindow, n - burnInIndex)", () => {
    const cases: Array<{ n: number; window: number; W: number }> = [
      { n: 524, window: 252, W: 252 },
      { n: 312, window: 252, W: 60 },
      { n: 100, window: 252, W: 60 }, // n < window
      { n: 80, window: 252, W: 60 }, // tight rolling room
    ];
    for (const c of cases) {
      const { burnInIndex, displayStartIndex } = deriveIndices(c.n, c.window, c.W);
      const visible = Math.max(0, c.n - displayStartIndex);
      const expected = Math.min(c.window, c.n - burnInIndex);
      expect(visible).toBe(expected);
    }
  });
});
