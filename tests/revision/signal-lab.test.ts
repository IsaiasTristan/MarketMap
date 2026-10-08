import { describe, expect, it } from "vitest";
import type { PtPanel } from "@/lib/revision/legb-history";
import {
  buildTickerCandidates,
  comboZ,
  evaluateZSeries,
  orthogonalizeZ,
  peerZSeries,
  rollWeekShare,
  type LabTickerInput,
} from "@/lib/revision/signal-lab";

function panel(entries: Array<[string, number]>): PtPanel {
  return new Map(entries.map(([k, pt]) => [k, { dateIso: "2025-01-01", pt, source: "TIPRANKS" as string | null }]));
}

describe("buildTickerCandidates", () => {
  const grid = ["2025-01-06", "2025-01-13", "2025-01-20"];
  const input: LabTickerInput = {
    ticker: "T",
    // week0: two analysts; week1: both raise ~+10%; week2: both raise again ~+10%
    panels: [
      panel([["a", 100], ["b", 200]]),
      panel([["a", 110], ["b", 220]]),
      panel([["a", 121], ["b", 242]]),
    ],
    netUpDown: [0, 2, -1],
    recoEvents: [
      { dateIso: "2025-01-05", key: "a", score: 0 },
      { dateIso: "2025-01-12", key: "a", score: 1 },
    ],
    closes: [100, 110, 121],
  };
  const c = buildTickerCandidates(input, grid, 180);

  it("matched 1w PT revision is the mean per-analyst pct change", () => {
    expect(c.pt_matched_1w[0]).toBeNull();
    expect(c.pt_matched_1w[1]!).toBeCloseTo(0.1, 6);
    expect(c.pt_matched_1w[2]!).toBeCloseTo(0.1, 6);
  });

  it("chain-links the 4w window (compounding)", () => {
    // trailing product over weeks 0..2 of (1+0.1)(1+0.1) - 1 at week2
    expect(c.pt_matched_4w[2]!).toBeCloseTo(1.1 * 1.1 - 1, 6);
  });

  it("rating net trailing sum", () => {
    expect(c.rating_net_4w[2]!).toBeCloseTo(0 + 2 - 1, 6);
  });

  it("implied upside uses mean panel target over close", () => {
    // week0 mean target 150 / close 100 - 1
    expect(c.pt_implied_upside[0]!).toBeCloseTo(150 / 100 - 1, 6);
  });
});

describe("peerZSeries + comboZ + orthogonalizeZ", () => {
  const tickers = ["A", "B", "C", "D"];
  const peerOf = new Map(tickers.map((t) => [t, "PEER"]));
  const raw = new Map<string, Array<number | null>>([
    ["A", [1]],
    ["B", [2]],
    ["C", [3]],
    ["D", [4]],
  ]);

  it("z-scores within the peer group each week (zero mean)", () => {
    const z = peerZSeries(raw, tickers, peerOf, 1);
    const vals = tickers.map((t) => z.get(t)![0]!);
    const meanZ = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(meanZ).toBeCloseTo(0, 6);
    expect(z.get("A")![0]!).toBeLessThan(0);
    expect(z.get("D")![0]!).toBeGreaterThan(0);
  });

  it("orthogonalizeZ removes the control's linear component (residual uncorrelated)", () => {
    const sig = peerZSeries(raw, tickers, peerOf, 1);
    // control identical to signal -> residual should be ~0 everywhere
    const resid = orthogonalizeZ(sig, sig, tickers, 1);
    for (const t of tickers) expect(resid.get(t)![0]!).toBeCloseTo(0, 6);
  });

  it("comboZ blends with signed weights (gap = a - b)", () => {
    const a = peerZSeries(raw, tickers, peerOf, 1);
    const b = peerZSeries(new Map(tickers.map((t) => [t, [0]])), tickers, peerOf, 1);
    const gap = comboZ([{ z: a, weight: 1 }, { z: b, weight: -1 }], tickers, 1);
    // b is degenerate (all equal -> no z), so gap == a normalized by |1|
    expect(gap.get("D")![0]!).toBeCloseTo(a.get("D")![0]!, 6);
  });
});

describe("evaluateZSeries", () => {
  it("recovers a strong positive IC when z predicts the forward return", () => {
    const tickers = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const grid = Array.from({ length: 6 }, (_, w) => `2025-0${w + 1}-01`);
    const z = new Map<string, Array<number | null>>();
    const forward: Array<Map<string, number>> = [];
    tickers.forEach((t, i) => z.set(t, grid.map(() => i)));
    for (let w = 0; w < grid.length; w++) {
      const m = new Map<string, number>();
      // forward endpoint prints only when w+1 within window
      if (w + 1 < grid.length) tickers.forEach((t, i) => m.set(t, i * 0.001));
      forward.push(m);
    }
    const rep = evaluateZSeries(z, tickers, grid, forward, 1, "2025-03-01", "2025-01-01");
    expect(rep.test.meanIC!).toBeGreaterThan(0.9);
    expect(rep.horizonWeeks).toBe(1);
    expect(rep.coverage).toBeGreaterThan(0);
  });
});

describe("rollWeekShare", () => {
  it("counts ticker-weeks whose forward fiscal period changed", () => {
    const m = new Map<string, Array<string | null>>([
      ["A", ["2025-12-31", "2025-12-31", "2026-12-31"]], // 1 roll of 2 transitions
      ["B", ["2025-12-31", "2025-12-31", "2025-12-31"]], // 0 rolls of 2
    ]);
    const r = rollWeekShare(m);
    expect(r.totalTransitions).toBe(4);
    expect(r.rollWeeks).toBe(1);
  });
});
