import { describe, expect, it } from "vitest";

import {
  MIN_ORTH_NAMES,
  computePtRevOrth,
  type PtRevOrthRow,
} from "@/lib/revision/orthogonalize";

function peers(tickers: string[], key = "GRP"): Map<string, string> {
  return new Map(tickers.map((t) => [t, key]));
}

describe("computePtRevOrth", () => {
  it("strips the cross-sectional trailing-return component", () => {
    // revision = 0.5 * ret4w exactly => every residual is zero => no dispersion.
    const rows: PtRevOrthRow[] = [
      { ticker: "A", ret4w: -0.10, ptRevisionRecon: -0.05 },
      { ticker: "B", ret4w: 0.00, ptRevisionRecon: 0.00 },
      { ticker: "C", ret4w: 0.10, ptRevisionRecon: 0.05 },
      { ticker: "D", ret4w: 0.20, ptRevisionRecon: 0.10 },
    ];
    const out = computePtRevOrth(rows, peers(["A", "B", "C", "D"]));
    expect(out.beta).toBeCloseTo(0.5, 12);
    for (const t of ["A", "B", "C", "D"]) {
      expect(out.byTicker.get(t)!.raw).toBeCloseTo(0, 12);
    }
    // zero dispersion => no z assigned (std guard), never NaN.
    for (const t of ["A", "B", "C", "D"]) {
      expect(out.byTicker.get(t)!.z).toBeNull();
    }
  });

  it("ranks the name that revised most for its trailing return highest", () => {
    const rows: PtRevOrthRow[] = [
      { ticker: "A", ret4w: -0.10, ptRevisionRecon: -0.05 },
      { ticker: "B", ret4w: 0.00, ptRevisionRecon: 0.00 },
      { ticker: "C", ret4w: 0.10, ptRevisionRecon: 0.05 },
      // same +5% revision as C but no price move to explain it.
      { ticker: "D", ret4w: 0.00, ptRevisionRecon: 0.05 },
    ];
    const out = computePtRevOrth(rows, peers(["A", "B", "C", "D"]));
    const d = out.byTicker.get("D")!;
    const c = out.byTicker.get("C")!;
    expect(d.raw!).toBeGreaterThan(c.raw!);
    expect(d.z!).toBeGreaterThan(c.z!);
    // residuals of an OLS fit sum to zero.
    const sum = ["A", "B", "C", "D"].reduce((a, t) => a + out.byTicker.get(t)!.raw!, 0);
    expect(sum).toBeCloseTo(0, 12);
  });

  it("z-scores within peer group, not universe-wide", () => {
    // Two groups with different residual levels; each is centered on itself.
    const rows: PtRevOrthRow[] = [
      { ticker: "A1", ret4w: 0, ptRevisionRecon: 0.10 },
      { ticker: "A2", ret4w: 0, ptRevisionRecon: 0.12 },
      { ticker: "A3", ret4w: 0, ptRevisionRecon: 0.14 },
      { ticker: "B1", ret4w: 0, ptRevisionRecon: -0.10 },
      { ticker: "B2", ret4w: 0, ptRevisionRecon: -0.12 },
      { ticker: "B3", ret4w: 0, ptRevisionRecon: -0.14 },
    ];
    const peerOf = new Map<string, string>([
      ["A1", "A"], ["A2", "A"], ["A3", "A"],
      ["B1", "B"], ["B2", "B"], ["B3", "B"],
    ]);
    const out = computePtRevOrth(rows, peerOf);
    // A2 and B2 are each the median of their own group => z ~ 0 despite very
    // different raw levels.
    expect(out.byTicker.get("A2")!.z!).toBeCloseTo(0, 6);
    expect(out.byTicker.get("B2")!.z!).toBeCloseTo(0, 6);
    expect(out.byTicker.get("A3")!.z!).toBeGreaterThan(0);
    expect(out.byTicker.get("B1")!.z!).toBeGreaterThan(0);
    expect(out.zN).toBe(6);
  });

  it("yields null for names missing either the signal or the control", () => {
    const rows: PtRevOrthRow[] = [
      { ticker: "A", ret4w: -0.10, ptRevisionRecon: -0.02 },
      { ticker: "B", ret4w: 0.05, ptRevisionRecon: 0.03 },
      { ticker: "C", ret4w: 0.10, ptRevisionRecon: 0.01 },
      { ticker: "D", ret4w: 0.10, ptRevisionRecon: null },
      { ticker: "E", ret4w: null, ptRevisionRecon: 0.09 },
      { ticker: "F", ret4w: Number.NaN, ptRevisionRecon: 0.09 },
    ];
    const out = computePtRevOrth(rows, peers(["A", "B", "C", "D", "E", "F"]));
    expect(out.regressionN).toBe(3);
    for (const t of ["D", "E", "F"]) {
      expect(out.byTicker.get(t)!.raw).toBeNull();
      expect(out.byTicker.get(t)!.z).toBeNull();
    }
    expect(out.byTicker.get("A")!.raw).not.toBeNull();
  });

  it("no-ops below the minimum cross-section", () => {
    const rows: PtRevOrthRow[] = [
      { ticker: "A", ret4w: 0.01, ptRevisionRecon: 0.02 },
      { ticker: "B", ret4w: 0.02, ptRevisionRecon: 0.03 },
    ];
    expect(rows.length).toBeLessThan(MIN_ORTH_NAMES);
    const out = computePtRevOrth(rows, peers(["A", "B"]));
    expect(out.beta).toBeNull();
    expect(out.zN).toBe(0);
    expect(out.byTicker.get("A")!.z).toBeNull();
  });

  it("winsorizes the signal so one blow-up target cannot set the slope", () => {
    // 1/99 winsorization only bites on a real cross-section (n >= ~100).
    const n = 200;
    const base: PtRevOrthRow[] = Array.from({ length: n }, (_, i) => ({
      ticker: `T${i}`,
      ret4w: (i - n / 2) / 1000,
      ptRevisionRecon: (i - n / 2) / 2000,
    }));
    const tickers = base.map((r) => r.ticker);
    const clean = computePtRevOrth(base, peers(tickers));
    // Not exactly 0.5: winsorization clips the two tails of the clean series too.
    expect(clean.beta).toBeCloseTo(0.5, 3);

    const withOutlier = base.map((r) =>
      r.ticker === "T0" ? { ...r, ptRevisionRecon: 50 } : r,
    );
    const dirty = computePtRevOrth(withOutlier, peers(tickers));
    // The blow-up is clipped to the cross-section's 99th percentile, so it
    // cannot flip the slope; unwinsorized this single row drags beta negative.
    expect(dirty.beta!).toBeGreaterThan(0);
    expect(Math.abs(dirty.beta! - clean.beta!)).toBeLessThan(0.2);
  });

  it("tolerates a constant control (degenerate regression) without NaN", () => {
    const rows: PtRevOrthRow[] = [
      { ticker: "A", ret4w: 0.03, ptRevisionRecon: 0.01 },
      { ticker: "B", ret4w: 0.03, ptRevisionRecon: 0.02 },
      { ticker: "C", ret4w: 0.03, ptRevisionRecon: 0.03 },
    ];
    const out = computePtRevOrth(rows, peers(["A", "B", "C"]));
    expect(out.beta).toBe(0);
    for (const t of ["A", "B", "C"]) {
      expect(Number.isFinite(out.byTicker.get(t)!.raw!)).toBe(true);
      expect(Number.isFinite(out.byTicker.get(t)!.z!)).toBe(true);
    }
    // Pure demean when the control has no dispersion.
    expect(out.byTicker.get("B")!.raw).toBeCloseTo(0, 12);
  });
});
