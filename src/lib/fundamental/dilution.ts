/**
 * Box 12 — Dilution & Capital-Raising. Pure math, no I/O. Are equity holders
 * benefiting from the operating improvement, or being diluted to fund losses /
 * acquisitions / debt service? Kept separate from Balance-Sheet Strength (Box 6
 * = solvency risk; Box 12 = value transfer to/from common shareholders).
 * Components oriented HIGHER = BETTER (less dilution / net buybacks better):
 *  - shareGrowthQuality = -(diluted YoY share growth)
 *  - shareCagr2yQuality = -(2yr diluted share CAGR)
 *  - netIssuanceQuality = -((issued + repurchased) / avg market cap)
 *  - sbcQuality         = -(stock-based comp / revenue)
 *
 * FMP sign convention: commonStockIssued >= 0, commonStockRepurchased <= 0, so
 * (issued + repurchased) is NET issuance (positive = net dilution, negative =
 * net buyback).
 */

export interface DilutionInputs {
  /** Chronological (oldest -> newest) diluted weighted-average share counts. */
  dilutedShares: Array<number | null>;
  /** TTM common stock issued (>= 0). */
  commonStockIssuedTtm: number | null;
  /** TTM common stock repurchased (<= 0). */
  commonStockRepurchasedTtm: number | null;
  /** TTM stock-based compensation. */
  sbcTtm: number | null;
  /** TTM revenue. */
  revenueTtm: number | null;
  /** Average market capitalization over the period (current is acceptable). */
  avgMarketCap: number | null;
}

export const DILUTION_COMPONENT_KEYS = [
  "shareGrowthQuality",
  "shareCagr2yQuality",
  "netIssuanceQuality",
  "sbcQuality",
] as const;

export type DilutionComponents = Record<(typeof DILUTION_COMPONENT_KEYS)[number], number | null>;

/** Finite value `back` quarters before the last finite point (or null). */
function finiteBack(series: Array<number | null>, back: number): number | null {
  const f = series.filter((v): v is number => v !== null && Number.isFinite(v));
  if (f.length === 0) return null;
  const idx = f.length - 1 - back;
  return idx >= 0 ? f[idx]! : null;
}

function lastFinite(series: Array<number | null>): number | null {
  const f = series.filter((v): v is number => v !== null && Number.isFinite(v));
  return f.length ? f[f.length - 1]! : null;
}

/** current / prior - 1, guarded. */
function growth(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || Math.abs(prior) < 1e-9) return null;
  return current / prior - 1;
}

/** Compute the dilution components (already oriented higher = better). */
export function dilutionComponents(inputs: DilutionInputs): DilutionComponents {
  const now = lastFinite(inputs.dilutedShares);
  const yearAgo = finiteBack(inputs.dilutedShares, 4);
  const twoYearAgo = finiteBack(inputs.dilutedShares, 8);

  const yoy = growth(now, yearAgo);
  let cagr2y: number | null = null;
  if (now !== null && twoYearAgo !== null && twoYearAgo > 0 && now > 0) {
    cagr2y = Math.pow(now / twoYearAgo, 1 / 2) - 1;
  }

  let netIssuanceYield: number | null = null;
  if (
    inputs.avgMarketCap !== null &&
    inputs.avgMarketCap > 0 &&
    (inputs.commonStockIssuedTtm !== null || inputs.commonStockRepurchasedTtm !== null)
  ) {
    const net = (inputs.commonStockIssuedTtm ?? 0) + (inputs.commonStockRepurchasedTtm ?? 0);
    netIssuanceYield = net / inputs.avgMarketCap;
  }

  let sbcToRev: number | null = null;
  if (inputs.sbcTtm !== null && inputs.revenueTtm !== null && inputs.revenueTtm > 0) {
    sbcToRev = inputs.sbcTtm / inputs.revenueTtm;
  }

  return {
    shareGrowthQuality: yoy === null ? null : -yoy,
    shareCagr2yQuality: cagr2y === null ? null : -cagr2y,
    netIssuanceQuality: netIssuanceYield === null ? null : -netIssuanceYield,
    sbcQuality: sbcToRev === null ? null : -sbcToRev,
  };
}
