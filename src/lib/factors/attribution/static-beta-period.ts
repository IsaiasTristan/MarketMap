/**
 * Static-horizon-beta period decomposition.
 *
 * Given a SINGLE OLS fit estimated over the full horizon window (betas + daily
 * intercept α) and the per-day factor returns / excess returns restricted to a
 * trailing Attribution Period, decompose the realized period return into
 * per-factor systematic contributions, an alpha contribution, and a residual
 * plug:
 *
 *   Σ_{t in period} y_t  =  Σ_f (β_f × Σ_t r_{t,f})  +  (α × obs)  +  residual
 *                            └────── systematic ──────┘   └─ alpha ─┘
 *   residual = Σ y_t − systematic − (α × obs)              (the plug)
 *
 * This is the one canonical estimator the per-stock grid AND the per-stock
 * waterfall both read, so the two surfaces tie by construction. It is applied
 * identically in simple space (y, raw factor returns, simple-OLS fit) and in
 * log space (y_log, ln(1+r) factor returns, log-OLS fit).
 *
 * Pure function — no I/O — so the identity is unit-tested directly.
 */

export interface StaticBetaPeriodResult {
  /** Per-factor contribution β_f × Σ_t r_{t,f}, same order as `betas`. */
  returnByFactor: number[];
  /** Σ_f returnByFactor. */
  systematic: number;
  /** α × observations (the static intercept applied across the period). */
  alphaSum: number;
  /** Σ y_t − systematic − alphaSum (the realized-minus-explained plug). */
  residualSum: number;
  /** Number of days in the slice. */
  observations: number;
}

/**
 * @param betas       Factor loadings from the static horizon OLS (length k).
 * @param alpha       Daily intercept from the same fit.
 * @param factorRows  Per-day factor returns over the period (obs rows × k cols).
 * @param y           Per-day excess returns over the period (length obs).
 *
 * `factorRows` and `y` MUST already be sliced to the period and aligned 1:1.
 */
export function computeStaticBetaPeriodSlice(
  betas: number[],
  alpha: number,
  factorRows: ReadonlyArray<ReadonlyArray<number>>,
  y: ReadonlyArray<number>,
): StaticBetaPeriodResult {
  const k = betas.length;
  const observations = y.length;

  const factorSums = new Array<number>(k).fill(0);
  for (const row of factorRows) {
    for (let fi = 0; fi < k; fi++) factorSums[fi]! += row[fi] ?? 0;
  }

  const returnByFactor = new Array<number>(k);
  let systematic = 0;
  for (let fi = 0; fi < k; fi++) {
    const rc = (betas[fi] ?? 0) * factorSums[fi]!;
    returnByFactor[fi] = rc;
    systematic += rc;
  }

  let sumY = 0;
  for (const v of y) sumY += v ?? 0;

  const alphaSum = alpha * observations;
  const residualSum = sumY - systematic - alphaSum;

  return { returnByFactor, systematic, alphaSum, residualSum, observations };
}
