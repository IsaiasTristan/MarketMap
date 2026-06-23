/**
 * Live MACRO14 factor composition contract.
 *
 * Pins the algebraic definition of each live 1D factor return in
 * `composeLiveFactors` against the historical-pipeline construction so a
 * future divergence between live and at-close attribution gets caught at the
 * unit-test layer (rather than as a silent intraday vs end-of-day jump).
 */
import { describe, it, expect } from "vitest";
import {
  composeLiveFactors,
  type LiveFactorEtf,
  type LiveQuote,
} from "../../src/lib/factors/live/compose-live-factors";

/** Build a `prevClose / price` pair that produces an exact target return. */
function quote(targetReturn: number, prevClose = 100): LiveQuote {
  return { prevClose, price: prevClose * (1 + targetReturn) };
}

function allQuotes(returns: Record<LiveFactorEtf, number>): Partial<Record<LiveFactorEtf, LiveQuote>> {
  const out: Partial<Record<LiveFactorEtf, LiveQuote>> = {};
  for (const [k, v] of Object.entries(returns) as [LiveFactorEtf, number][]) {
    out[k] = quote(v);
  }
  return out;
}

describe("composeLiveFactors — algebraic contract", () => {
  const rf = 0.0001;
  // Pick distinct, non-symmetric returns so a sign / order mistake is caught.
  const r = {
    SPY: 0.010,
    ACWI: 0.008,
    IEF: 0.002,
    DBC: 0.012,
    EEM: 0.011,
    UUP: -0.003,
    TIP: 0.001,
    USMV: 0.006,
    QUAL: 0.009,
    DBMF: 0.004,
    GVIP: 0.015,
    SVXY: 0.020,
    MTUM: 0.007,
    IVE: 0.005,
    IVW: 0.013,
  } as Record<LiveFactorEtf, number>;

  const { returns, missingLegs } = composeLiveFactors({
    quotes: allQuotes(r),
    rfDaily: rf,
  });

  it("emits all 14 MACRO14 factors when every leg is present", () => {
    expect(missingLegs).toEqual([]);
    const codes = Object.keys(returns).sort();
    expect(codes).toEqual(
      [
        "BAB",
        "COMM",
        "CROWD",
        "EM",
        "EQ",
        "FX",
        "HML",
        "INFL",
        "LOCAL_EQ",
        "MOM",
        "QMJ",
        "RATES",
        "SHORT_VOL",
        "TREND",
      ].sort(),
    );
  });

  it("EQ = ACWI − RF", () => {
    expect(returns.EQ).toBeCloseTo(r.ACWI - rf, 12);
  });

  it("LOCAL_EQ = SPY − ACWI", () => {
    expect(returns.LOCAL_EQ).toBeCloseTo(r.SPY - r.ACWI, 12);
  });

  it("RATES = IEF − RF", () => {
    expect(returns.RATES).toBeCloseTo(r.IEF - rf, 12);
  });

  it("COMM = DBC − RF", () => {
    expect(returns.COMM).toBeCloseTo(r.DBC - rf, 12);
  });

  it("EM = EEM − SPY", () => {
    expect(returns.EM).toBeCloseTo(r.EEM - r.SPY, 12);
  });

  it("FX = UUP − RF", () => {
    expect(returns.FX).toBeCloseTo(r.UUP - rf, 12);
  });

  it("INFL = TIP − IEF", () => {
    expect(returns.INFL).toBeCloseTo(r.TIP - r.IEF, 12);
  });

  it("SHORT_VOL = SVXY − RF", () => {
    expect(returns.SHORT_VOL).toBeCloseTo(r.SVXY - rf, 12);
  });

  it("TREND = DBMF − RF", () => {
    expect(returns.TREND).toBeCloseTo(r.DBMF - rf, 12);
  });

  it("CROWD = GVIP − SPY", () => {
    expect(returns.CROWD).toBeCloseTo(r.GVIP - r.SPY, 12);
  });

  it("BAB ≈ USMV − SPY (gap proxy)", () => {
    expect(returns.BAB).toBeCloseTo(r.USMV - r.SPY, 12);
  });

  it("QMJ ≈ QUAL − SPY (gap proxy)", () => {
    expect(returns.QMJ).toBeCloseTo(r.QUAL - r.SPY, 12);
  });

  it("MOM ≈ MTUM (gap proxy; raw daily move)", () => {
    expect(returns.MOM).toBeCloseTo(r.MTUM, 12);
  });

  it("HML ≈ IVE − IVW (gap proxy)", () => {
    expect(returns.HML).toBeCloseTo(r.IVE - r.IVW, 12);
  });
});

describe("composeLiveFactors — strict-drop on missing legs", () => {
  it("drops EQ when ACWI is missing but leaves LOCAL_EQ (also needs ACWI) reported", () => {
    const r = {
      SPY: 0.01,
      IEF: 0,
      DBC: 0,
      EEM: 0,
      UUP: 0,
      TIP: 0,
      USMV: 0,
      QUAL: 0,
      DBMF: 0,
      GVIP: 0,
      SVXY: 0,
      MTUM: 0,
      IVE: 0,
      IVW: 0,
    } as Record<Exclude<LiveFactorEtf, "ACWI">, number>;
    const quotes: Partial<Record<LiveFactorEtf, LiveQuote>> = {};
    for (const [k, v] of Object.entries(r) as [LiveFactorEtf, number][]) {
      quotes[k] = quote(v);
    }
    const out = composeLiveFactors({ quotes, rfDaily: 0 });
    expect(out.returns.EQ).toBeUndefined();
    expect(out.returns.LOCAL_EQ).toBeUndefined();
    expect(out.returns.EM).toBeCloseTo(-r.SPY, 12); // EM = EEM − SPY = 0 − SPY
    expect(out.missingLegs).toContain("ACWI");
    // Factors that don't depend on ACWI should still be present.
    expect(out.returns.RATES).toBeDefined();
    expect(out.returns.MOM).toBeDefined();
  });

  it("emits zero factors when no quotes are provided", () => {
    const out = composeLiveFactors({ quotes: {}, rfDaily: 0 });
    expect(Object.keys(out.returns).length).toBe(0);
  });

  it("treats non-finite prevClose as missing", () => {
    const out = composeLiveFactors({
      quotes: { SPY: { price: 100, prevClose: 0 }, ACWI: quote(0.01) },
      rfDaily: 0,
    });
    expect(out.returns.LOCAL_EQ).toBeUndefined();
    expect(out.missingLegs).toContain("SPY");
  });
});

describe("composeLiveFactors — RF handling", () => {
  it("subtracts RF from the excess-of-RF legs only", () => {
    const r = {
      SPY: 0,
      ACWI: 0,
      IEF: 0,
      DBC: 0,
      EEM: 0,
      UUP: 0,
      TIP: 0,
      USMV: 0,
      QUAL: 0,
      DBMF: 0,
      GVIP: 0,
      SVXY: 0,
      MTUM: 0,
      IVE: 0,
      IVW: 0,
    } as Record<LiveFactorEtf, number>;
    const out = composeLiveFactors({ quotes: allQuotes(r), rfDaily: 0.001 });
    expect(out.returns.EQ).toBeCloseTo(-0.001, 12);
    expect(out.returns.RATES).toBeCloseTo(-0.001, 12);
    expect(out.returns.COMM).toBeCloseTo(-0.001, 12);
    expect(out.returns.FX).toBeCloseTo(-0.001, 12);
    expect(out.returns.SHORT_VOL).toBeCloseTo(-0.001, 12);
    expect(out.returns.TREND).toBeCloseTo(-0.001, 12);
    // Spread / RF-neutral factors are not touched by RF.
    expect(out.returns.LOCAL_EQ).toBeCloseTo(0, 12);
    expect(out.returns.EM).toBeCloseTo(0, 12);
    expect(out.returns.INFL).toBeCloseTo(0, 12);
    expect(out.returns.CROWD).toBeCloseTo(0, 12);
    expect(out.returns.BAB).toBeCloseTo(0, 12);
    expect(out.returns.QMJ).toBeCloseTo(0, 12);
    expect(out.returns.MOM).toBeCloseTo(0, 12);
    expect(out.returns.HML).toBeCloseTo(0, 12);
  });

  it("falls back to rf=0 when rfDaily is non-finite", () => {
    const out = composeLiveFactors({
      quotes: { ACWI: quote(0.01) },
      rfDaily: Number.NaN,
    });
    expect(out.returns.EQ).toBeCloseTo(0.01, 12);
  });
});
