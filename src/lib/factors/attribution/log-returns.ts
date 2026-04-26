/**
 * Log-return helpers for the dual-mode attribution pipeline.
 *
 * Multi-period attribution can only reconcile *exactly* to compounded
 * realised return when the underlying daily series is additive in log space.
 * The simple-return identity `Σ y_t = Σ ŷ_t + Σ ε_t` holds at the daily
 * level, but its sum is **not** a compounded total return. Sums of
 * `ln(1 + r_t)` are: `Σ ln(1+r_t) = ln(Π(1+r_t))`, so
 * `exp(Σ ln(1+r_t)) - 1` recovers the cumulative geometric return exactly.
 *
 * Domain notes:
 *   - All inputs are daily decimal simple returns (e.g. 0.012 = 1.2%).
 *   - When `1 + r ≤ 0`, `ln` is undefined; we return `null` and let
 *     callers strict-drop the row, mirroring the Phase 3 Q3 lock.
 *   - Excess-in-log uses `ln(1 + r_stock) - ln(1 + r_f)` per the plan
 *     ("preferred excess log return"), which keeps the daily identity
 *     `y_log = stock_log - rf_log` consistent with the OLS LHS.
 */
const MAX_FACTOR_DROP = -1; // 1 + x must be > 0 (drop, do not clamp)

/** Convert simple decimal return to log return. Returns null when 1+x ≤ 0. */
export function logOnePlus(simpleReturn: number): number | null {
  if (!Number.isFinite(simpleReturn)) return null;
  if (simpleReturn <= MAX_FACTOR_DROP) return null;
  return Math.log(1 + simpleReturn);
}

/**
 * Excess log return per the plan: `ln(1 + r_stock) - ln(1 + r_f)`.
 * Returns null if either piece is undefined.
 */
export function stockExcessLog(rStock: number, rF: number): number | null {
  const ls = logOnePlus(rStock);
  const lf = logOnePlus(rF);
  if (ls == null || lf == null) return null;
  return ls - lf;
}

/**
 * Convert a single simple factor return to a log factor return.
 * Returns null when `1 + f ≤ 0` (caller drops the row).
 */
export function factorLogFromSimple(f: number): number | null {
  return logOnePlus(f);
}

/**
 * Convert a row of simple factor returns to log factor returns.
 * Returns null if any element is undefined / out-of-domain so callers
 * can apply a strict-drop policy on the whole row.
 */
export function factorRowLog(simpleRow: number[]): number[] | null {
  const out: number[] = new Array(simpleRow.length);
  for (let i = 0; i < simpleRow.length; i++) {
    const v = factorLogFromSimple(simpleRow[i]!);
    if (v == null) return null;
    out[i] = v;
  }
  return out;
}

/** Helper for tests / UI: cumulative log → geometric return. */
export function expSumMinus1(logSum: number): number {
  if (!Number.isFinite(logSum)) return 0;
  return Math.exp(logSum) - 1;
}
