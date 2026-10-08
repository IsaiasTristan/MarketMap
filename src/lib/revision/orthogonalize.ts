/**
 * Engine 1 — THE rank signal definition (pure, no I/O).
 *
 * `ptRevOrthZ` is the orthogonalized matched-panel price-target revision: the
 * part of a week's per-analyst target revision that is NOT explained by the
 * stock's own trailing 4-week return. Analysts largely revise after price
 * moves, so the raw matched-panel revision is partly a trailing-return proxy;
 * removing that cross-sectional component is what made the signal significant
 * at every horizon in the signal lab (and positively monotonic in the deciles,
 * which the raw version is not).
 *
 * Fixed order, and the ONLY place it is defined — scoring, the screen-row
 * materializer, the signal lab and Validation all call this function, so the
 * live rank and the backtested rank can never drift apart:
 *
 *   1. winsorize the raw revision universe-wide at 1/99
 *   2. cross-sectional OLS residual vs trailing 4w return (universe-wide)
 *   3. peer-relative z-score of that residual (subsector, sector fallback)
 *
 * A name needs BOTH a matched-panel revision and a trailing return to be
 * ranked; without the control there is nothing to orthogonalize against, so it
 * yields null rather than an un-adjusted value that would not be comparable.
 */
import { winsorize, zScores } from "@/lib/revision/scoring";

/** Universe-wide winsorization of the raw revision, per the signal spec. */
export const ORTH_WINSOR_P = 0.01;
/** Below this many eligible names a cross-sectional regression is meaningless. */
export const MIN_ORTH_NAMES = 3;

export interface PtRevOrthRow {
  ticker: string;
  /** Matched-panel weekly PT revision (RevisionLegBWeekly.ptRevisionRecon). */
  ptRevisionRecon: number | null;
  /** Trailing 4-week return (RevisionPriceSnapshot.ret4w) — the control. */
  ret4w: number | null;
}

export interface PtRevOrthEntry {
  ticker: string;
  /** Pre-z residual (the orthogonalized revision in raw units). */
  raw: number | null;
  /** Peer-relative z of the residual — the rank. */
  z: number | null;
}

export interface PtRevOrthResult {
  byTicker: Map<string, PtRevOrthEntry>;
  /** This week's cross-sectional loading of revision on trailing return. */
  beta: number | null;
  /** Names in the regression (had both signal and control). */
  regressionN: number;
  /** Names that received a peer z (peer bucket had enough dispersion). */
  zN: number;
}

/**
 * @param rows one entry per universe ticker (missing inputs allowed)
 * @param peerOf ticker -> peer-group key (from resolvePeerGroups)
 */
export function computePtRevOrth(
  rows: PtRevOrthRow[],
  peerOf: Map<string, string>,
): PtRevOrthResult {
  const byTicker = new Map<string, PtRevOrthEntry>();
  for (const r of rows) byTicker.set(r.ticker, { ticker: r.ticker, raw: null, z: null });

  const eligible = rows.filter(
    (r) =>
      r.ptRevisionRecon !== null &&
      Number.isFinite(r.ptRevisionRecon) &&
      r.ret4w !== null &&
      Number.isFinite(r.ret4w),
  );
  if (eligible.length < MIN_ORTH_NAMES) {
    return { byTicker, beta: null, regressionN: eligible.length, zN: 0 };
  }

  // 1. winsorize the signal universe-wide (targets move in fat-tailed jumps).
  const ys = winsorize(
    eligible.map((r) => r.ptRevisionRecon as number),
    ORTH_WINSOR_P,
  );
  const xs = eligible.map((r) => r.ret4w as number);
  const n = eligible.length;

  // 2. cross-sectional OLS residual vs the trailing return.
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const beta = sxx > 1e-18 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  eligible.forEach((r, i) => {
    byTicker.get(r.ticker)!.raw = ys[i]! - (alpha + beta * xs[i]!);
  });

  // 3. peer-relative z of the residual (same primitive every other signal uses).
  const buckets = new Map<string, string[]>();
  for (const r of eligible) {
    const key = peerOf.get(r.ticker) ?? "Unclassified";
    const arr = buckets.get(key);
    if (arr) arr.push(r.ticker);
    else buckets.set(key, [r.ticker]);
  }
  let zN = 0;
  for (const tickers of buckets.values()) {
    const { z } = zScores(tickers.map((t) => byTicker.get(t)!.raw));
    for (const [i, zv] of z) {
      byTicker.get(tickers[i]!)!.z = zv;
      zN++;
    }
  }

  return { byTicker, beta, regressionN: n, zN };
}
