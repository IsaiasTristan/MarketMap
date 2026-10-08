import { describe, expect, it } from "vitest";
import {
  computeRawSignals,
  estimateBreadth,
  epsDispersion,
  proximityWeight,
  ratingNet,
  relChange,
  type StockWeek,
} from "@/lib/revision/signals";

describe("relChange", () => {
  it("computes guarded relative change", () => {
    expect(relChange(110, 100)).toBeCloseTo(0.1, 12);
    expect(relChange(90, 100)).toBeCloseTo(-0.1, 12);
  });
  it("returns null on missing or zero denominator", () => {
    expect(relChange(null, 100)).toBeNull();
    expect(relChange(100, null)).toBeNull();
    expect(relChange(100, 0)).toBeNull();
  });
});

describe("ratingNet", () => {
  it("is bull-minus-bear share in [-1,1]", () => {
    expect(ratingNet({ strongBuy: 5, buy: 5, hold: 0, sell: 0, strongSell: 0 })).toBe(1);
    expect(ratingNet({ strongBuy: 0, buy: 0, hold: 0, sell: 5, strongSell: 5 })).toBe(-1);
    expect(ratingNet({ strongBuy: 2, buy: 2, hold: 4, sell: 1, strongSell: 1 })).toBeCloseTo((4 - 2) / 10, 12);
  });
  it("returns null when empty", () => {
    expect(ratingNet(null)).toBeNull();
    expect(ratingNet({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBeNull();
  });
});

describe("estimateBreadth", () => {
  it("is (up - down) / total across tracked metrics", () => {
    const prior = { revenue: 100, eps: 1, ebitda: 50, ebit: 40, netIncome: 30 };
    const curr = { revenue: 110, eps: 1.1, ebitda: 49, ebit: 40, netIncome: 31 };
    // up: revenue, eps, netIncome (3); down: ebitda (1); flat: ebit (0 change, counts in total but neither up/down)
    // total counts metrics with valid prior+curr = 5; up=3 down=1 -> (3-1)/5
    expect(estimateBreadth(curr, prior)).toBeCloseTo((3 - 1) / 5, 12);
  });
  it("returns null without a prior", () => {
    expect(estimateBreadth({ revenue: 1 }, null)).toBeNull();
  });
});

describe("epsDispersion", () => {
  it("is (high-low)/|avg|", () => {
    expect(epsDispersion(0.8, 1, 1.2)).toBeCloseTo(0.4, 12);
  });
  it("null when avg ~ 0 or missing", () => {
    expect(epsDispersion(0.8, 0, 1.2)).toBeNull();
    expect(epsDispersion(null, 1, 1.2)).toBeNull();
  });
});

describe("proximityWeight", () => {
  it("is 1 outside the window and ramps to 1+maxBoost at the report", () => {
    expect(proximityWeight(null)).toBe(1);
    expect(proximityWeight(45)).toBe(1);
    expect(proximityWeight(30)).toBeCloseTo(1, 12);
    expect(proximityWeight(0)).toBeCloseTo(2, 12);
    expect(proximityWeight(15)).toBeCloseTo(1.5, 12);
  });
});

describe("computeRawSignals", () => {
  const base: StockWeek = {
    ticker: "T",
    epsAvg: 2.2,
    revenueAvg: 110,
    metricAvgs: { revenue: 110, eps: 2.2, ebitda: 55, ebit: 44, netIncome: 33 },
    epsLow: 2.0,
    epsHigh: 2.4,
    ratingDist: { strongBuy: 3, buy: 5, hold: 2, sell: 0, strongSell: 0 },
    ptConsensus: 130,
    daysToEarnings: null,
  };
  const prior: StockWeek = {
    ...base,
    epsAvg: 2.0,
    revenueAvg: 100,
    metricAvgs: { revenue: 100, eps: 2.0, ebitda: 55, ebit: 40, netIncome: 30 },
    ratingDist: { strongBuy: 1, buy: 5, hold: 4, sell: 0, strongSell: 0 },
    ptConsensus: 120,
  };

  it("produces directional signals from week-over-week deltas", () => {
    const s = computeRawSignals(base, prior);
    expect(s.epsRevision).toBeCloseTo(0.1, 6);
    expect(s.revenueRevision).toBeCloseTo(0.1, 6);
    expect(s.ptRevision).toBeCloseTo(10 / 120, 6);
    expect(s.ratingMomentum).not.toBeNull();
    expect(s.estimateBreadth).not.toBeNull();
    expect(s.ratingNet).toBeCloseTo((3 + 5) / 10, 6);
  });

  it("nulls Leg A revision signals when there is no prior week", () => {
    const s = computeRawSignals(base, null);
    expect(s.epsRevision).toBeNull();
    expect(s.revenueRevision).toBeNull();
    expect(s.estimateBreadth).toBeNull();
    expect(s.ratingMomentum).toBeNull();
    // Level signals still available from the current snapshot.
    expect(s.ratingNet).not.toBeNull();
    expect(s.epsDispersion).not.toBeNull();
  });

  it("amplifies change signals near the earnings date", () => {
    const far = computeRawSignals({ ...base, daysToEarnings: 90 }, prior);
    const near = computeRawSignals({ ...base, daysToEarnings: 0 }, prior);
    expect(near.epsRevision!).toBeCloseTo(far.epsRevision! * 2, 6);
  });
});

describe("computeRawSignals — fiscal-year roll", () => {
  const FY1 = "2025-12-31";
  const FY2 = "2026-12-31";
  // Prior week tracks FY1: eps 2.0, revenue 100.
  const prior: StockWeek = {
    ticker: "T",
    epsAvg: 2.0,
    revenueAvg: 100,
    metricAvgs: { revenue: 100, eps: 2.0, ebitda: 55, ebit: 40, netIncome: 30 },
    epsLow: 1.9,
    epsHigh: 2.1,
    ratingDist: { strongBuy: 1, buy: 5, hold: 4, sell: 0, strongSell: 0 },
    ptConsensus: 120,
    daysToEarnings: null,
    forwardFiscalDate: FY1,
    periodAvgs: new Map([[FY1, { revenue: 100, eps: 2.0, ebitda: 55, ebit: 40, netIncome: 30 }]]),
  };

  it("measures the SAME period's revision, not the FY1->FY2 level jump", () => {
    // Fiscal year rolled: forward is now FY2 (much higher level), but FMP still
    // reports FY1 with a small genuine +5% eps / +5% revenue revision.
    const curr: StockWeek = {
      ticker: "T",
      epsAvg: 3.0, // FY2 leaders — the level jump we must NOT read as a revision
      revenueAvg: 150,
      metricAvgs: { revenue: 150, eps: 3.0, ebitda: 80, ebit: 65, netIncome: 50 },
      epsLow: 2.8,
      epsHigh: 3.2,
      ratingDist: prior.ratingDist,
      ptConsensus: 130,
      daysToEarnings: null,
      forwardFiscalDate: FY2,
      periodAvgs: new Map([
        [FY1, { revenue: 105, eps: 2.1, ebitda: 56, ebit: 41, netIncome: 31 }],
        [FY2, { revenue: 150, eps: 3.0, ebitda: 80, ebit: 65, netIncome: 50 }],
      ]),
    };
    const s = computeRawSignals(curr, prior);
    expect(s.epsRevision!).toBeCloseTo(0.05, 6); // (2.1-2.0)/2.0, NOT (3.0-2.0)/2.0
    expect(s.revenueRevision!).toBeCloseTo(0.05, 6);
    // Breadth compares FY1 curr vs FY1 prior: all five metrics up -> +1.
    expect(s.estimateBreadth!).toBeCloseTo(1, 6);
  });

  it("yields null revisions when the prior period is no longer estimated", () => {
    const curr: StockWeek = {
      ticker: "T",
      epsAvg: 3.0,
      revenueAvg: 150,
      metricAvgs: { revenue: 150, eps: 3.0, ebitda: 80, ebit: 65, netIncome: 50 },
      epsLow: 2.8,
      epsHigh: 3.2,
      ratingDist: prior.ratingDist,
      ptConsensus: 130,
      daysToEarnings: null,
      forwardFiscalDate: FY2,
      periodAvgs: new Map([[FY2, { revenue: 150, eps: 3.0, ebitda: 80, ebit: 65, netIncome: 50 }]]),
    };
    const s = computeRawSignals(curr, prior);
    expect(s.epsRevision).toBeNull();
    expect(s.revenueRevision).toBeNull();
    expect(s.estimateBreadth).toBeNull();
  });

  it("is unchanged on a normal (non-roll) week", () => {
    const curr: StockWeek = {
      ...prior,
      epsAvg: 2.2,
      revenueAvg: 110,
      metricAvgs: { revenue: 110, eps: 2.2, ebitda: 55, ebit: 44, netIncome: 33 },
      periodAvgs: new Map([[FY1, { revenue: 110, eps: 2.2, ebitda: 55, ebit: 44, netIncome: 33 }]]),
    };
    const s = computeRawSignals(curr, prior);
    expect(s.epsRevision!).toBeCloseTo(0.1, 6);
    expect(s.revenueRevision!).toBeCloseTo(0.1, 6);
  });
});
