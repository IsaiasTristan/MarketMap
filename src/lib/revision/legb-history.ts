/**
 * Engine 1 — pure point-in-time weekly reconstruction of Leg B (ratings +
 * price targets) from the backfilled event tables. Leg A snapshots only accrue
 * forward, but RatingEvent / PriceTargetEvent carry full history — so streaks
 * and validation stats can be computed with real depth from day one by
 * replaying events onto the weekly grid. Only data dated <= each grid date is
 * visible at that date (look-ahead-free). No I/O.
 */
import { actionScore } from "@/lib/revision/backtest";
import { relChange } from "@/lib/revision/signals";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";

export interface RatingEventLike {
  dateIso: string; // YYYY-MM-DD
  action: string | null;
}

export interface PtEventLike {
  dateIso: string; // YYYY-MM-DD
  analyst: string | null; // analystCompany; null = anonymous voice, kept individually
  priceTarget: number;
}

export interface WeeklyNetAction {
  net: number; // sum of +-1 action scores over events in (prevGridDate, gridDate]
  count: number; // rating events in the window (any action)
}

/**
 * Per grid date: the net upgrade/downgrade score and event count over the
 * window (previous grid date, this grid date]. The first grid date's window
 * reaches back one nominal 7-day step — events before that never enter. Weeks
 * with no events are {net: 0, count: 0}.
 */
export function weeklyNetActions(events: RatingEventLike[], grid: string[]): WeeklyNetAction[] {
  if (grid.length === 0) return [];
  const sorted = [...events].sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  const firstWindowStart = new Date(new Date(`${grid[0]}T00:00:00Z`).getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const out: WeeklyNetAction[] = [];
  let lo = 0;
  let prev = firstWindowStart;
  for (const gridDate of grid) {
    // Skip events at or before the window start (earlier windows / pre-grid).
    while (lo < sorted.length && sorted[lo]!.dateIso <= prev) lo++;
    let net = 0;
    let count = 0;
    while (lo < sorted.length && sorted[lo]!.dateIso <= gridDate) {
      net += actionScore(sorted[lo]!.action);
      count++;
      lo++;
    }
    out.push({ net, count });
    prev = gridDate;
  }
  return out;
}

/**
 * Point-in-time price-target consensus per grid date: each analyst's LATEST
 * target on or before the date (later targets from the same firm supersede
 * earlier ones), targets older than `staleDays` evicted, mean of survivors.
 * Events with a null analyst can't be superseded, so each counts as its own
 * voice until it goes stale. Null when no live targets.
 */
export function reconstructPtConsensus(
  events: PtEventLike[],
  grid: string[],
  staleDays: number = REVISION_THRESHOLDS.ptReconStaleDays,
): Array<number | null> {
  const sorted = events
    .filter((e) => Number.isFinite(e.priceTarget) && e.priceTarget > 0)
    .sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  const byAnalyst = new Map<string, { dateIso: string; pt: number }>();
  const anonymous: Array<{ dateIso: string; pt: number }> = [];
  const out: Array<number | null> = [];
  const DAY_MS = 86_400_000;
  let lo = 0;
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.dateIso <= gridDate) {
      const e = sorted[lo]!;
      if (e.analyst) byAnalyst.set(e.analyst, { dateIso: e.dateIso, pt: e.priceTarget });
      else anonymous.push({ dateIso: e.dateIso, pt: e.priceTarget });
      lo++;
    }
    const cutoffMs = new Date(`${gridDate}T00:00:00Z`).getTime() - staleDays * DAY_MS;
    const live: number[] = [];
    for (const v of byAnalyst.values()) {
      if (new Date(`${v.dateIso}T00:00:00Z`).getTime() >= cutoffMs) live.push(v.pt);
    }
    for (const v of anonymous) {
      if (new Date(`${v.dateIso}T00:00:00Z`).getTime() >= cutoffMs) live.push(v.pt);
    }
    out.push(live.length > 0 ? live.reduce((a, b) => a + b, 0) / live.length : null);
  }
  return out;
}

/**
 * Week-over-week relative change of the reconstructed consensus — the Leg-B
 * analog of ptRevision. First week (no prior) and gaps propagate null.
 */
export function ptRevisionFromConsensus(consensus: Array<number | null>): Array<number | null> {
  return consensus.map((v, i) => {
    if (i === 0) return null;
    const prior = consensus[i - 1] ?? null;
    return relChange(v ?? null, prior);
  });
}
