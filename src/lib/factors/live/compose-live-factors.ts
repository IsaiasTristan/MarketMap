/**
 * compose-live-factors — pure composition of the 14 MACRO14 factor returns for
 * a single LIVE intraday day, from raw ETF live quotes.
 *
 * Mirrors the construction recipes in `factor-pipeline-macro.service.ts` and
 * `factor-pipeline.service.ts` so that today's live 1D factor row uses the
 * same definitions as the historical `FactorReturnDaily` series the betas were
 * fit on. The 4 published factors (MOM/HML/BAB/QMJ) have no live source, so
 * the existing ETF gap-proxies are used raw:
 *   MOM ≈ MTUM  (mean-adjusted historically; raw daily move here)
 *   HML ≈ IVE − IVW
 *   BAB ≈ USMV − SPY
 *   QMJ ≈ QUAL − SPY
 *
 * Live ETF returns use `(price - prevClose)/prevClose` (vs stored adjClose);
 * identical except on ex-div days — acceptable for a 1D move.
 *
 * Pure: no I/O, no caching. The caller fetches the live quote map and the
 * latest stored RF and passes them in. RF intraday ≈ last stored daily RF.
 *
 * Returns `null` for the whole composition when any required ETF leg is
 * missing (no silent zero-fill — same policy as the historical pipeline).
 * The caller may then fall back to the cached at-close period slice.
 */
import type { FactorCode } from "@/types/factors";

/** A single live ETF quote: live price + prior trading-day close. */
export interface LiveQuote {
  price: number;
  prevClose: number;
}

/** All ETF symbols needed to compose the live MACRO14 factor row. */
export const LIVE_FACTOR_ETFS = [
  // Macro / asset-class legs (shared with the historical pipeline)
  "SPY",
  "ACWI",
  "IEF",
  "DBC",
  "EEM",
  "UUP",
  "TIP",
  "USMV",
  "QUAL",
  "DBMF",
  "GVIP",
  "SVXY",
  // Gap proxies for the published factors (no live source)
  "MTUM", // MOM proxy
  "IVE", // HML long leg (value)
  "IVW", // HML short leg (growth)
] as const;

export type LiveFactorEtf = (typeof LIVE_FACTOR_ETFS)[number];

export interface ComposeLiveFactorsInput {
  /** Live quote per ETF ticker (case-insensitive expected; caller normalises). */
  quotes: Partial<Record<LiveFactorEtf, LiveQuote>>;
  /** Daily simple decimal RF (latest stored row). Used to subtract for excess-of-RF legs. */
  rfDaily: number;
}

export interface ComposeLiveFactorsResult {
  /** Per-factor live 1D simple decimal returns. */
  returns: Partial<Record<FactorCode, number>>;
  /** RF used (passed through for convenience). */
  rf: number;
  /** ETFs that were required by at least one factor but had no usable quote. */
  missingLegs: LiveFactorEtf[];
}

/** Convert a live quote into a simple 1D decimal return, or null when unusable. */
function quoteReturn(q: LiveQuote | undefined): number | null {
  if (!q) return null;
  const { price, prevClose } = q;
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(prevClose) ||
    prevClose <= 0
  ) {
    return null;
  }
  return price / prevClose - 1;
}

/**
 * Compose the live MACRO14 factor row from the given ETF quote map.
 *
 * Definitions mirror `refreshMacroFactorPipeline`:
 *   EQ        = ACWI - RF
 *   LOCAL_EQ  = SPY  - ACWI
 *   RATES     = IEF  - RF
 *   COMM      = DBC  - RF
 *   EM        = EEM  - SPY
 *   FX        = UUP  - RF
 *   INFL      = TIP  - IEF
 *   SHORT_VOL = SVXY - RF
 *   TREND     = DBMF - RF
 *   CROWD     = GVIP - SPY
 *   BAB       ≈ USMV - SPY   (gap proxy — no live AQR series)
 *   QMJ       ≈ QUAL - SPY   (gap proxy — no live AQR series)
 *   MOM       ≈ MTUM         (gap proxy — no live KF series)
 *   HML       ≈ IVE  - IVW   (gap proxy — no live KF series)
 *
 * A leg with no usable quote drops the corresponding factor (still returned
 * via `missingLegs` so the caller can surface a downgrade). Factors that can
 * still be composed are emitted.
 */
export function composeLiveFactors(
  input: ComposeLiveFactorsInput,
): ComposeLiveFactorsResult {
  const { quotes, rfDaily } = input;
  const r: Partial<Record<LiveFactorEtf, number | null>> = {};
  for (const sym of LIVE_FACTOR_ETFS) {
    r[sym] = quoteReturn(quotes[sym]);
  }

  const missing = new Set<LiveFactorEtf>();
  function need(...syms: LiveFactorEtf[]): boolean {
    let ok = true;
    for (const s of syms) {
      if (r[s] == null) {
        missing.add(s);
        ok = false;
      }
    }
    return ok;
  }

  const returns: Partial<Record<FactorCode, number>> = {};
  const rf = Number.isFinite(rfDaily) ? rfDaily : 0;

  // Macro / asset-class legs (excess-of-RF)
  if (need("ACWI")) returns.EQ = r.ACWI! - rf;
  if (need("SPY", "ACWI")) returns.LOCAL_EQ = r.SPY! - r.ACWI!;
  if (need("IEF")) returns.RATES = r.IEF! - rf;
  if (need("DBC")) returns.COMM = r.DBC! - rf;
  if (need("EEM", "SPY")) returns.EM = r.EEM! - r.SPY!;
  if (need("UUP")) returns.FX = r.UUP! - rf;
  if (need("TIP", "IEF")) returns.INFL = r.TIP! - r.IEF!;
  if (need("SVXY")) returns.SHORT_VOL = r.SVXY! - rf;
  if (need("DBMF")) returns.TREND = r.DBMF! - rf;
  if (need("GVIP", "SPY")) returns.CROWD = r.GVIP! - r.SPY!;

  // Style premia — gap proxies (RF-neutral spreads or raw)
  if (need("USMV", "SPY")) returns.BAB = r.USMV! - r.SPY!;
  if (need("QUAL", "SPY")) returns.QMJ = r.QUAL! - r.SPY!;
  if (need("MTUM")) returns.MOM = r.MTUM!;
  if (need("IVE", "IVW")) returns.HML = r.IVE! - r.IVW!;

  return { returns, rf, missingLegs: [...missing] };
}
