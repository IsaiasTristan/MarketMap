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
  /** Supersession key: expertUID (TipRanks) or normalized firm (FMP); null = anonymous voice, kept individually. */
  analyst: string | null;
  priceTarget: number;
  /** Optional provenance tag; drives the panel source-mix diagnostic only. */
  source?: string;
}

/** One analyst's live target inside a week's point-in-time panel. */
export interface PtPanelEntry {
  dateIso: string;
  pt: number;
  source: string | null;
}

/** Point-in-time panel per grid date, keyed by supersession key (anonymous voices get synthetic keys). */
export type PtPanel = Map<string, PtPanelEntry>;

/**
 * Per grid date: every analyst's LATEST target on or before the date (later
 * targets from the same key supersede earlier ones), with targets older than
 * `staleDays` evicted. The panel is the primitive both the level and the
 * matched-panel revision derive from.
 */
export function reconstructPtPanels(
  events: PtEventLike[],
  grid: string[],
  staleDays: number = REVISION_THRESHOLDS.ptReconStaleDays,
): PtPanel[] {
  const sorted = events
    .filter((e) => Number.isFinite(e.priceTarget) && e.priceTarget > 0)
    .sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  const latest = new Map<string, PtPanelEntry>();
  const DAY_MS = 86_400_000;
  let lo = 0;
  let anonSeq = 0;
  const out: PtPanel[] = [];
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.dateIso <= gridDate) {
      const e = sorted[lo]!;
      const key = e.analyst ?? `anon:${anonSeq++}`;
      latest.set(key, { dateIso: e.dateIso, pt: e.priceTarget, source: e.source ?? null });
      lo++;
    }
    const cutoffMs = new Date(`${gridDate}T00:00:00Z`).getTime() - staleDays * DAY_MS;
    const panel: PtPanel = new Map();
    for (const [key, v] of latest) {
      if (new Date(`${v.dateIso}T00:00:00Z`).getTime() >= cutoffMs) panel.set(key, v);
    }
    out.push(panel);
  }
  return out;
}

/** Level: mean of the live panel's targets (null when empty). */
export function ptConsensusFromPanels(panels: PtPanel[]): Array<number | null> {
  return panels.map((p) => {
    if (p.size === 0) return null;
    let sum = 0;
    for (const v of p.values()) sum += v.pt;
    return sum / p.size;
  });
}

export interface MatchedPtRevision {
  revision: number | null; // mean of per-analyst pt_t / pt_{t-1} - 1 over analysts in BOTH weeks
  matched: number; // analysts present in both weeks (the denominator)
}

/**
 * Matched-panel (chain-linked) week-over-week revision: only analysts present
 * in both the prior and current panel contribute, so panel entry/exit — a new
 * initiation, a stale eviction, or a source going dark — generates exactly
 * zero signal by construction. Unchanged targets contribute 0 (a diffusion
 * measure: analysts who did not move are real zeros). First week is null.
 */
export function ptRevisionMatched(panels: PtPanel[]): MatchedPtRevision[] {
  return panels.map((cur, i) => {
    if (i === 0) return { revision: null, matched: 0 };
    const prev = panels[i - 1]!;
    let sum = 0;
    let n = 0;
    for (const [key, v] of cur) {
      const p = prev.get(key);
      if (!p || p.pt <= 0) continue;
      sum += v.pt / p.pt - 1;
      n++;
    }
    return { revision: n > 0 ? sum / n : null, matched: n };
  });
}

export interface PtMoveCounts {
  up: number;
  down: number;
}

/**
 * Per week, how many matched analysts RAISED and how many CUT their target —
 * the raw counts the screen shows next to the score ("4 / 0 of 5"). Same
 * matched-panel basis as `ptRevisionMatched`, so `up + down <= matched <=
 * panel size` holds by construction and a new initiation is never counted as
 * a raise.
 */
export function ptMoveCounts(panels: PtPanel[]): PtMoveCounts[] {
  return panels.map((cur, i) => {
    if (i === 0) return { up: 0, down: 0 };
    const prev = panels[i - 1]!;
    let up = 0;
    let down = 0;
    for (const [key, v] of cur) {
      const p = prev.get(key);
      if (!p || p.pt <= 0) continue;
      if (v.pt > p.pt) up++;
      else if (v.pt < p.pt) down++;
    }
    return { up, down };
  });
}

export interface RatingActionCounts {
  up: number;
  down: number;
  init: number;
}

/**
 * Per grid date, rating events in the window (previous grid date, this grid
 * date] split by action. Display only — rating moves are never in the rank.
 */
export function weeklyActionCounts(
  events: RatingEventLike[],
  grid: string[],
): RatingActionCounts[] {
  if (grid.length === 0) return [];
  const sorted = [...events].sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  const firstWindowStart = new Date(new Date(`${grid[0]}T00:00:00Z`).getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const out: RatingActionCounts[] = [];
  let lo = 0;
  let prev = firstWindowStart;
  for (const gridDate of grid) {
    while (lo < sorted.length && sorted[lo]!.dateIso <= prev) lo++;
    const counts: RatingActionCounts = { up: 0, down: 0, init: 0 };
    while (lo < sorted.length && sorted[lo]!.dateIso <= gridDate) {
      const a = (sorted[lo]!.action ?? "").toLowerCase();
      if (a.includes("upgrade")) counts.up++;
      else if (a.includes("downgrade")) counts.down++;
      else if (a.includes("init") || a.includes("resum")) counts.init++;
      lo++;
    }
    out.push(counts);
    prev = gridDate;
  }
  return out;
}

export interface PtPanelStats {
  size: number;
  /** Share of the panel whose latest target came from the source named `primary` (null when empty). */
  sourceMix: number | null;
}

/** Panel size + source mix per week — the observability that keeps a decaying panel from being silent. */
export function ptPanelStats(panels: PtPanel[], primary = "TIPRANKS"): PtPanelStats[] {
  return panels.map((p) => {
    if (p.size === 0) return { size: 0, sourceMix: null };
    let fromPrimary = 0;
    for (const v of p.values()) if (v.source === primary) fromPrimary++;
    return { size: p.size, sourceMix: fromPrimary / p.size };
  });
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
 * Point-in-time price-target consensus LEVEL per grid date (mean of the live
 * panel). Thin wrapper over reconstructPtPanels kept for display/context and
 * back-compat; the SIGNAL is ptRevisionMatched, not the difference of levels.
 */
export function reconstructPtConsensus(
  events: PtEventLike[],
  grid: string[],
  staleDays: number = REVISION_THRESHOLDS.ptReconStaleDays,
): Array<number | null> {
  return ptConsensusFromPanels(reconstructPtPanels(events, grid, staleDays));
}

/**
 * Week-over-week relative change of the consensus LEVEL. Retained for
 * reference/diagnostics only: it moves whenever panel composition changes
 * (initiations, stale evictions, a source going dark), so it is NOT used as
 * the production signal — see ptRevisionMatched.
 */
export function ptRevisionFromConsensus(consensus: Array<number | null>): Array<number | null> {
  return consensus.map((v, i) => {
    if (i === 0) return null;
    const prior = consensus[i - 1] ?? null;
    return relChange(v ?? null, prior);
  });
}
