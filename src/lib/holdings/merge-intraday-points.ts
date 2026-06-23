/**
 * Merge intraday price points for live chart append semantics.
 *
 * Keeps the full existing history and appends any incoming point with a
 * strictly newer timestamp. When timestamps match, updates price in place.
 */

export interface IntradayPricePoint {
  t: string;
  price: number;
}

function compareTimestamps(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Merge `incoming` into `existing` without duplicating timestamps.
 * Returns a new array; inputs are not mutated.
 */
export function mergeIntradayPoints(
  existing: IntradayPricePoint[],
  incoming: IntradayPricePoint[],
): IntradayPricePoint[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return [...incoming];

  const out = [...existing];
  const lastExistingT = out[out.length - 1]!.t;
  let startIdx = 0;

  // Skip incoming points that are strictly older than our tail — they are
  // already represented in `existing` from a prior fetch.
  while (
    startIdx < incoming.length &&
    compareTimestamps(incoming[startIdx]!.t, lastExistingT) < 0
  ) {
    startIdx++;
  }

  for (let i = startIdx; i < incoming.length; i++) {
    const pt = incoming[i]!;
    const last = out[out.length - 1];
    if (!last) {
      out.push(pt);
      continue;
    }
    const cmp = compareTimestamps(pt.t, last.t);
    if (cmp > 0) {
      out.push(pt);
    } else if (cmp === 0) {
      out[out.length - 1] = pt;
    }
    // cmp < 0: skip — stale point inside the retained window
  }

  return out;
}

const ONE_MINUTE_MS = 60_000;

/**
 * Append sparkline closes (no timestamps) onto an intraday series by
 * synthesizing timestamps after the last known point. Only appends when
 * the price differs from the current tail.
 */
export function appendSparklineTail(
  existing: IntradayPricePoint[],
  sparklineCloses: number[],
  intervalMs: number = ONE_MINUTE_MS,
): IntradayPricePoint[] {
  if (sparklineCloses.length === 0) return existing;

  const out = [...existing];
  let lastT =
    out.length > 0
      ? new Date(out[out.length - 1]!.t).getTime()
      : Date.now() - sparklineCloses.length * intervalMs;

  for (const price of sparklineCloses) {
    if (!Number.isFinite(price)) continue;
    const last = out[out.length - 1];
    if (last && last.price === price) continue;
    lastT += intervalMs;
    out.push({ t: new Date(lastT).toISOString(), price });
  }

  return out;
}
