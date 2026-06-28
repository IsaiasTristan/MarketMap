/**
 * Engine 2 — pure valuation-vs-own-history math. No I/O. This signal is
 * INTRA-TICKER by design: it compares each multiple to the name's own ~5yr
 * range, never cross-sectionally (a 35% gross margin means different things in
 * software vs distribution, and the same is true of multiples). It therefore
 * does NOT use the peer z-score path; it produces a percentile of the name
 * against itself.
 */

/**
 * Percentile rank of `value` within `history` in [0,1] (fraction of history
 * <= value). For a multiple where lower = cheaper, a low percentile = cheap vs
 * its own past. Null on empty history or non-finite value.
 */
export function percentileOf(value: number | null, history: Array<number | null>): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const h = history.filter((v): v is number => v !== null && Number.isFinite(v));
  if (h.length === 0) return null;
  const below = h.filter((v) => v <= value).length;
  return below / h.length;
}

export interface CurrentMultiples {
  peRatio: number | null;
  evToEbitda: number | null;
  priceToSales: number | null;
}

export interface MultipleHistory {
  peRatio: Array<number | null>;
  evToEbitda: Array<number | null>;
  priceToSales: Array<number | null>;
}

export interface ValuationPercentiles {
  peRatio: number | null;
  evToEbitda: number | null;
  priceToSales: number | null;
  /** Blended cheapness in [0,1]: 1 = cheapest vs own history, 0 = dearest. */
  cheapness: number | null;
}

/**
 * Keep only sensible positive multiples (a negative P/E or EV/EBITDA carries no
 * valuation meaning for a percentile-vs-history read).
 */
function positiveOnly(history: Array<number | null>): Array<number | null> {
  return history.map((v) => (v !== null && Number.isFinite(v) && v > 0 ? v : null));
}

/**
 * Per-multiple own-history percentile + a blended cheapness score. Each
 * multiple's percentile is the rank of the current value within its positive
 * history; cheapness = 1 - mean(available percentiles), so higher = cheaper.
 */
export function valuationPercentiles(
  current: CurrentMultiples,
  history: MultipleHistory,
): ValuationPercentiles {
  const pe = current.peRatio !== null && current.peRatio > 0
    ? percentileOf(current.peRatio, positiveOnly(history.peRatio))
    : null;
  const ev = current.evToEbitda !== null && current.evToEbitda > 0
    ? percentileOf(current.evToEbitda, positiveOnly(history.evToEbitda))
    : null;
  const ps = current.priceToSales !== null && current.priceToSales > 0
    ? percentileOf(current.priceToSales, positiveOnly(history.priceToSales))
    : null;
  const avail = [pe, ev, ps].filter((v): v is number => v !== null);
  const cheapness = avail.length
    ? 1 - avail.reduce((a, b) => a + b, 0) / avail.length
    : null;
  return { peRatio: pe, evToEbitda: ev, priceToSales: ps, cheapness };
}
