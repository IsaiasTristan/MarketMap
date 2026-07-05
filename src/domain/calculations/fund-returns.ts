/**
 * Fund returns engine — single-quarter math (Part 1), pure & DB-free.
 *
 * The ESTIMATED LONG-BOOK RETURN, NOT fund NAV: freeze the reported long book at a
 * period boundary, value-weight each position's ADJUSTED-price return over the
 * window, renormalize weights over the positions that have usable price data, and
 * chain quarters (chaining lives in return-series.ts). Contributions are each
 * position's weight × return, summing to the book return.
 *
 * Standing protocol: weights come from REPORTED values (levels), returns come from
 * the ADJUSTED price series — never mixed in one number. A position with no usable
 * adjusted return is dropped from the covered set and its weight is disclosed as
 * excluded, never silently treated as a 0% return.
 */
import { type FundOverviewConfig, FUND_OVERVIEW_CONFIG } from "./fund-overview-config";

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One position in a fund's frozen book, with its window return. */
export interface BookReturnPosition {
  ticker: string;
  /** Reported weight (fraction of book), from value / Σ value. */
  reportedWeight: number;
  /** Adjusted-price return over the window (fraction), or null when no usable price. */
  positionReturn: number | null;
}

/** Per-position contribution to the book return, over the renormalized covered set. */
export interface Contribution {
  ticker: string;
  /** Renormalized weight over covered names (fraction). */
  weight: number;
  /** Position's window return (fraction). */
  ret: number;
  /** weight × ret, in bps of book return (Σ contribBps = book return in bps). */
  contribBps: number;
}

export interface QuarterReturnResult {
  /** Value-weighted book return over the covered set (fraction), or null if nothing covered. */
  ret: number | null;
  /** % of reported book weight with usable return data. */
  coveragePct: number;
  /** Reported weight dropped (uncovered/delisted), in bps of book. */
  excludedWeightBps: number;
  positionsCovered: number;
  positionsTotal: number;
  /** Contributions over the renormalized covered set, descending by |contribBps|. */
  contributions: Contribution[];
}

/**
 * Value-weighted single-quarter book return + coverage + contributions.
 * Weights are renormalized over the COVERED positions (those with a usable return);
 * uncovered/delisted weight is reported as excludedWeightBps, never scored as 0%.
 */
export function quarterReturn(positions: BookReturnPosition[]): QuarterReturnResult {
  const totalWeight = positions.reduce((a, p) => a + (p.reportedWeight > 0 ? p.reportedWeight : 0), 0);
  const covered = positions.filter(
    (p) => p.reportedWeight > 0 && p.positionReturn != null && Number.isFinite(p.positionReturn),
  );
  const coveredWeight = covered.reduce((a, p) => a + p.reportedWeight, 0);

  const coveragePct = totalWeight > 0 ? round4((coveredWeight / totalWeight) * 100) : 0;
  const excludedWeightBps =
    totalWeight > 0 ? Math.round((1 - coveredWeight / totalWeight) * 10_000) : 0;

  if (!(coveredWeight > 0)) {
    return {
      ret: null,
      coveragePct,
      excludedWeightBps,
      positionsCovered: 0,
      positionsTotal: positions.length,
      contributions: [],
    };
  }

  const contributions: Contribution[] = covered.map((p) => {
    const w = p.reportedWeight / coveredWeight; // renormalize over covered names
    const ret = p.positionReturn as number;
    return { ticker: p.ticker, weight: round4(w), ret: round4(ret), contribBps: Math.round(w * ret * 10_000) };
  });
  contributions.sort((a, b) => Math.abs(b.contribBps) - Math.abs(a.contribBps));

  const ret = covered.reduce((a, p) => a + (p.reportedWeight / coveredWeight) * (p.positionReturn as number), 0);

  return {
    ret: round4(ret),
    coveragePct,
    excludedWeightBps,
    positionsCovered: covered.length,
    positionsTotal: positions.length,
    contributions,
  };
}

export type Confidence = "HIGH" | "MED" | "LOW";

/**
 * Estimate reliability from trailing-4q turnover (%/q): the less a fund trades
 * between snapshots, the closer the snapshot estimate tracks the real long book.
 */
export function returnConfidence(
  trailing4qTurnoverPct: number,
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): Confidence {
  const { high, med } = cfg.return_conf_bands;
  if (trailing4qTurnoverPct < high) return "HIGH";
  if (trailing4qTurnoverPct <= med) return "MED";
  return "LOW";
}

/** Coverage below the floor: renormalize + disclose (tag LOW COVERAGE). */
export function isLowCoverage(coveragePct: number, cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG): boolean {
  return coveragePct < cfg.coverage_min;
}

/**
 * fund_quality_weight = f(clone_alpha): a bounded multiplier, neutral 1.0 at 0
 * alpha AND when alpha is unknown (new/insufficient-history funds are never
 * penalized). Linear from neutral to `max` at +alpha_at_max and to `min` at
 * −alpha_at_max, clamped to [min, max].
 */
export function fundQualityWeight(
  cloneAlpha: number | null,
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): number {
  if (cloneAlpha == null || !Number.isFinite(cloneAlpha)) return 1;
  const { min, max, alpha_at_max } = cfg.fund_quality_weight;
  if (!(alpha_at_max > 0)) return 1;
  if (cloneAlpha >= 0) {
    const t = Math.min(cloneAlpha / alpha_at_max, 1);
    return round4(Math.min(max, 1 + t * (max - 1)));
  }
  const t = Math.min(-cloneAlpha / alpha_at_max, 1);
  return round4(Math.max(min, 1 - t * (1 - min)));
}
