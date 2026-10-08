/**
 * Engine 1 — validation stats (is the signal working?) computed weekly and
 * cached in RevisionAnalyticsSnapshot(kind="validation").
 *
 * Two variants, each labeled with its effective window:
 *  - FULL: the production (peer-relative, 5-signal) composite — only as deep
 *    as the Leg-A snapshot store (~2 weeks at launch, deepens weekly).
 *  - LEG_B: the reconstructed 2-signal Leg-B composite — full backfilled
 *    history from day one.
 * Forward returns are PEER-RELATIVE: each name's forward grid-step return
 * minus its peer group's mean that week (today's taxonomy — documented
 * limitation). ICs are Spearman rank correlations.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  decileForwardStats,
  icSummary,
  meanDrift,
  neweyWestTStat,
  rollingIC,
  spearmanIC,
  type DecileForwardStats,
  type RollingIcPoint,
  type SignalReturnPair,
  type WeeklyPairs,
} from "@/lib/revision/backtest";
import { resolvePeerGroups } from "@/lib/revision/aggregate";
import { forwardReturns } from "@/lib/revision/prices";

const t = REVISION_THRESHOLDS;

export interface VariantStats {
  weeklyIC: Array<{ date: string; ic: number | null; n: number }>;
  rollingIC4w: RollingIcPoint[];
  meanIC: number | null;
  /** Naive t-stat (mean / iid stderr) — overstated under overlapping windows. */
  tStat: number | null;
  /** Newey-West HAC t-stat (Bartlett lag = horizon - 1) — the honest one. */
  nwTStat: number | null;
  /** Effective independent weeks implied by the HAC correction. */
  effectiveIndependentWeeks: number | null;
  icWeeks: number;
  deciles: DecileForwardStats;
  effectiveWeeks: number;
  /** >= validationMinWeeks: deep enough to render at all (placeholder gate). */
  sufficient: boolean;
  /** >= validationHeadlineMinWeeks: deep enough to take the headline. */
  sufficientHeadline: boolean;
}

export interface ValidationPayload {
  snapshotDate: string;
  generatedAt: string;
  horizonWeeks: number;
  minWeeks: number;
  effectiveWeeks: { full: number; legB: number; price: number };
  fullComposite: VariantStats | null;
  legBComposite: VariantStats | null;
  perSignal: Array<{ signal: string; source: "FULL" | "LEG_B"; ic: number | null; weeks: number }>;
  postFlagDrift: {
    horizonsWeeks: number[];
    newLong: Array<number | null>;
    newShort: Array<number | null>;
    longFlags: number;
    shortFlags: number;
  };
  regime: { positiveWeeks: number; totalWeeks: number; window: number } | null;
  icCurrent: number | null; // latest rolling 4w IC (best variant available)
  icLongRun: number | null; // trailing icLongRunWeeks mean (same variant)
  icSource: "FULL" | "LEG_B" | null;
  /** Price-target panel health per grid week (source-transition observability). */
  ptPanel: PtPanelWeek[];
}

export interface PtPanelWeek {
  date: string;
  tickersWithPanel: number; // names with >= 1 live target
  meanSize: number | null; // mean live analysts per covered name
  meanMatched: number | null; // mean analysts in both weeks (revision denominator)
  meanSourceMix: number | null; // mean share of panel sourced from TipRanks
}

/** Pure: roll per-ticker weekly panel stats up to one row per grid week. */
export function summarizePtPanels(
  rows: Array<{
    snapshotDate: string;
    ptPanelSize: number | null;
    ptPanelMatched: number | null;
    ptSourceMix: number | null;
  }>,
): PtPanelWeek[] {
  const byDate = new Map<string, { n: number; size: number; matched: number; mixSum: number; mixN: number }>();
  for (const r of rows) {
    if (r.ptPanelSize === null || r.ptPanelSize <= 0) continue;
    const acc = byDate.get(r.snapshotDate) ?? { n: 0, size: 0, matched: 0, mixSum: 0, mixN: 0 };
    acc.n++;
    acc.size += r.ptPanelSize;
    acc.matched += r.ptPanelMatched ?? 0;
    if (r.ptSourceMix !== null) {
      acc.mixSum += r.ptSourceMix;
      acc.mixN++;
    }
    byDate.set(r.snapshotDate, acc);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, a]) => ({
      date,
      tickersWithPanel: a.n,
      meanSize: a.n ? a.size / a.n : null,
      meanMatched: a.n ? a.matched / a.n : null,
      meanSourceMix: a.mixN ? a.mixSum / a.mixN : null,
    }));
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface EntryGrid {
  dates: string[]; // ascending grid
  /** t+1 entry price series per ticker, aligned to `dates`. */
  entries: Map<string, Array<number | null>>;
  tickers: string[];
}

/**
 * The t+1 entry grid. Every forward return in Validation is measured
 * entry-to-entry (`closeNext[t] -> closeNext[t+h]`), never from the snapshot
 * close: revision events dated on the snapshot date can post after that
 * close, so entering at t books a move the queue could not have traded.
 */
async function loadEntryGrid(): Promise<EntryGrid> {
  const rows = await prisma.revisionPriceSnapshot.findMany({
    select: { ticker: true, snapshotDate: true, closeNext: true },
  });
  const dateSet = new Set<number>();
  for (const r of rows) dateSet.add(r.snapshotDate.getTime());
  const dateMs = [...dateSet].sort((a, b) => a - b);
  const dateIdx = new Map(dateMs.map((d, i) => [d, i]));
  const entries = new Map<string, Array<number | null>>();
  for (const r of rows) {
    let arr = entries.get(r.ticker);
    if (!arr) {
      arr = new Array<number | null>(dateMs.length).fill(null);
      entries.set(r.ticker, arr);
    }
    arr[dateIdx.get(r.snapshotDate.getTime())!] = r.closeNext;
  }
  return { dates: dateMs.map((d) => isoOf(new Date(d))), entries, tickers: [...entries.keys()] };
}

export interface ForwardRelResult {
  /** week index -> ticker -> peer-relative forward return. */
  byWeek: Map<number, Map<string, number>>;
  /** Ticker-weeks whose horizon fits the grid but lacked a tradeable entry. */
  droppedTickerWeeks: number;
  measuredTickerWeeks: number;
}

/**
 * Peer-relative forward returns per (week, ticker): the entry-to-entry
 * forward return minus its peer-group mean that week. Weeks whose forward
 * endpoint hasn't printed yet yield nothing; ticker-weeks with no tradeable
 * entry are dropped and counted (they feed the survivorship note).
 */
function buildForwardRel(
  grid: EntryGrid,
  peersOf: Map<string, string>,
  horizon: number,
): ForwardRelResult {
  const byTicker = new Map<string, Array<number | null>>();
  let droppedTickerWeeks = 0;
  let measuredTickerWeeks = 0;
  for (const ticker of grid.tickers) {
    const f = forwardReturns(grid.entries.get(ticker)!, horizon);
    byTicker.set(ticker, f.values);
    droppedTickerWeeks += f.dropped;
    measuredTickerWeeks += f.measured;
  }

  const byWeek = new Map<number, Map<string, number>>();
  for (let w = 0; w + horizon < grid.dates.length; w++) {
    const raw = new Map<string, number>();
    const groupSums = new Map<string, { sum: number; n: number }>();
    for (const ticker of grid.tickers) {
      const fwd = byTicker.get(ticker)![w];
      if (fwd === null || fwd === undefined) continue;
      raw.set(ticker, fwd);
      const g = peersOf.get(ticker) ?? "Unclassified";
      const acc = groupSums.get(g);
      if (acc) {
        acc.sum += fwd;
        acc.n++;
      } else groupSums.set(g, { sum: fwd, n: 1 });
    }
    const rel = new Map<string, number>();
    for (const [ticker, fwd] of raw) {
      const g = peersOf.get(ticker) ?? "Unclassified";
      const acc = groupSums.get(g)!;
      rel.set(ticker, fwd - acc.sum / acc.n);
    }
    byWeek.set(w, rel);
  }
  return { byWeek, droppedTickerWeeks, measuredTickerWeeks };
}

function buildVariant(
  weekly: Array<{ date: string; pairs: SignalReturnPair[] }>,
  horizon: number,
): VariantStats | null {
  const withPairs = weekly.filter((w) => w.pairs.length >= 3);
  if (withPairs.length === 0) return null;
  const weeklyIC = withPairs.map((w) => ({ date: w.date, ic: spearmanIC(w.pairs), n: w.pairs.length }));
  const rolling = rollingIC(withPairs as WeeklyPairs[], t.rollingIcWindow, "spearman");
  const icSeries = weeklyIC.map((w) => w.ic);
  const summary = icSummary(icSeries);
  // Overlapping h-week forward windows autocorrelate the weekly-IC series over
  // h-1 subsequent weeks; correct the t-stat with a Bartlett-kernel HAC estimate.
  const nw = neweyWestTStat(icSeries, Math.max(0, horizon - 1));
  const pooled = withPairs.flatMap((w) => w.pairs);
  return {
    weeklyIC,
    rollingIC4w: rolling,
    meanIC: summary.mean,
    tStat: summary.tStat,
    nwTStat: nw.tStat,
    effectiveIndependentWeeks: nw.effectiveN,
    icWeeks: summary.n,
    deciles: decileForwardStats(pooled),
    effectiveWeeks: withPairs.length,
    sufficient: withPairs.length >= t.validationMinWeeks,
    sufficientHeadline: withPairs.length >= t.validationHeadlineMinWeeks,
  };
}

export async function computeAndCacheValidation(
  opts: { log?: (msg: string) => void } = {},
): Promise<ValidationPayload> {
  const log = opts.log ?? (() => {});
  const horizon = t.validationHorizonWeeks;

  const grid = await loadEntryGrid();
  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true, sector: true, subsector: true },
  });
  const peerGroups = resolvePeerGroups(refs.map((r) => ({ ticker: r.ticker, sector: r.sector, subsector: r.subsector })));
  const peersOf = new Map([...peerGroups.entries()].map(([ticker, g]) => [ticker, g.peerGroupKey]));
  const forward: ForwardRelResult = grid.dates.length
    ? buildForwardRel(grid, peersOf, horizon)
    : { byWeek: new Map(), droppedTickerWeeks: 0, measuredTickerWeeks: 0 };
  const fwdRel = forward.byWeek;
  const gridIdx = new Map(grid.dates.map((d, i) => [d, i]));

  // LEG_B variant: reconstructed composite over the full grid.
  const legbRows = await prisma.revisionLegBWeekly.findMany({
    select: {
      ticker: true,
      snapshotDate: true,
      composite: true,
      netUpDown: true,
      ptRevisionRecon: true,
      ptPanelSize: true,
      ptPanelMatched: true,
      ptSourceMix: true,
    },
  });
  const ptPanel = summarizePtPanels(
    legbRows.map((r) => ({
      snapshotDate: isoOf(r.snapshotDate),
      ptPanelSize: r.ptPanelSize,
      ptPanelMatched: r.ptPanelMatched,
      ptSourceMix: r.ptSourceMix,
    })),
  );
  const legbByWeek = new Map<number, Array<{ ticker: string; signal: number }>>();
  for (const r of legbRows) {
    if (r.composite === null) continue;
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w === undefined) continue;
    const arr = legbByWeek.get(w);
    const e = { ticker: r.ticker, signal: r.composite! };
    if (arr) arr.push(e);
    else legbByWeek.set(w, [e]);
  }
  const legbWeekly = [...legbByWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([w, entries]) => {
      const rel = fwdRel.get(w);
      const pairs: SignalReturnPair[] = [];
      if (rel) {
        for (const e of entries) {
          const fwd = rel.get(e.ticker);
          if (fwd !== undefined) pairs.push({ signal: e.signal, forwardReturn: fwd });
        }
      }
      return { date: grid.dates[w]!, pairs };
    });
  const legBComposite = buildVariant(legbWeekly, horizon);

  // FULL variant: production composite over the scored (Leg-A) weeks.
  const scoreRows = await prisma.revisionScore.findMany({
    where: { composite: { not: null } },
    select: { ticker: true, snapshotDate: true, composite: true, scoreJson: true },
  });
  const scoreByWeek = new Map<number, Array<{ ticker: string; signal: number; z: Record<string, number | null> }>>();
  for (const r of scoreRows) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w === undefined) continue;
    const j = r.scoreJson as { z?: Record<string, number | null> } | null;
    const arr = scoreByWeek.get(w);
    const e = { ticker: r.ticker, signal: r.composite!, z: j?.z ?? {} };
    if (arr) arr.push(e);
    else scoreByWeek.set(w, [e]);
  }
  const scoredWeeks = [...scoreByWeek.entries()].sort((a, b) => a[0] - b[0]);
  const fullWeekly = scoredWeeks.map(([w, entries]) => {
    const rel = fwdRel.get(w);
    const pairs: SignalReturnPair[] = [];
    if (rel) {
      for (const e of entries) {
        const fwd = rel.get(e.ticker);
        if (fwd !== undefined) pairs.push({ signal: e.signal, forwardReturn: fwd });
      }
    }
    return { date: grid.dates[w]!, pairs };
  });
  const fullComposite = buildVariant(fullWeekly, horizon);

  // Per-signal attribution. FULL uses the stored per-signal z's; LEG_B uses the
  // reconstructed raw signals over the full backfilled history (Spearman IC is
  // rank-based, so raw vs z-scored inputs give the identical coefficient).
  const perSignal: ValidationPayload["perSignal"] = [];
  const FULL_SIGNALS = ["estimateBreadth", "epsRevision", "ptRevision", "ratingMomentum", "revenueRevision"];
  for (const sig of FULL_SIGNALS) {
    const weekly = scoredWeeks.map(([w, entries]) => {
      const rel = fwdRel.get(w);
      const pairs: SignalReturnPair[] = [];
      if (rel) {
        for (const e of entries) {
          const z = e.z[sig];
          const fwd = rel.get(e.ticker);
          if (z !== null && z !== undefined && Number.isFinite(z) && fwd !== undefined)
            pairs.push({ signal: z, forwardReturn: fwd });
        }
      }
      return pairs;
    });
    const ics = weekly.filter((p) => p.length >= 3).map((p) => spearmanIC(p));
    const s = icSummary(ics);
    perSignal.push({ signal: sig, source: "FULL", ic: s.mean, weeks: s.n });
  }

  // LEG_B per-signal: the two reconstructed signals that feed the deep composite.
  const legbSignalByWeek = new Map<number, Array<{ ticker: string; netUpDown: number | null; ptRevisionRecon: number | null }>>();
  for (const r of legbRows) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w === undefined) continue;
    const e = { ticker: r.ticker, netUpDown: r.netUpDown, ptRevisionRecon: r.ptRevisionRecon };
    const arr = legbSignalByWeek.get(w);
    if (arr) arr.push(e);
    else legbSignalByWeek.set(w, [e]);
  }
  const legbScoredWeeks = [...legbSignalByWeek.entries()].sort((a, b) => a[0] - b[0]);
  const LEGB_SIGNALS: Array<"netUpDown" | "ptRevisionRecon"> = ["netUpDown", "ptRevisionRecon"];
  for (const sig of LEGB_SIGNALS) {
    const weekly = legbScoredWeeks.map(([w, entries]) => {
      const rel = fwdRel.get(w);
      const pairs: SignalReturnPair[] = [];
      if (rel) {
        for (const e of entries) {
          const v = e[sig];
          const fwd = rel.get(e.ticker);
          if (v !== null && v !== undefined && Number.isFinite(v) && fwd !== undefined)
            pairs.push({ signal: v, forwardReturn: fwd });
        }
      }
      return pairs;
    });
    const ics = weekly.filter((p) => p.length >= 3).map((p) => spearmanIC(p));
    const s = icSummary(ics);
    perSignal.push({ signal: sig, source: "LEG_B", ic: s.mean, weeks: s.n });
  }

  // Post-flag drift: forward peer-relative returns after NEW_LONG / NEW_SHORT.
  const horizons = [1, 2, 4, 8];
  const flags = await prisma.signalTransition.findMany({
    where: { type: { in: ["NEW_LONG", "NEW_SHORT"] } },
    select: { type: true, ticker: true, snapshotDate: true },
  });
  const driftOf = (side: "NEW_LONG" | "NEW_SHORT"): { drift: Array<number | null>; count: number } => {
    const rowsFor = flags.filter((f) => f.type === side && f.ticker);
    const perFlag: Array<Array<number | null>> = rowsFor.map((f) => {
      const w = gridIdx.get(isoOf(f.snapshotDate));
      if (w === undefined) return horizons.map(() => null);
      return horizons.map((h) => {
        // Peer-relative forward return at horizon h from the flag week.
        const relH = h === horizon ? fwdRel.get(w) : null;
        if (relH) return relH.get(f.ticker!) ?? null;
        const series = grid.entries.get(f.ticker!);
        const a = series?.[w] ?? null;
        const b = series?.[w + h] ?? null;
        return a !== null && b !== null && a > 0 ? b / a - 1 : null;
      });
    });
    return { drift: meanDrift(perFlag), count: rowsFor.length };
  };
  const longDrift = driftOf("NEW_LONG");
  const shortDrift = driftOf("NEW_SHORT");

  // Regime + headline IC. FULL only takes the headline once it clears the
  // deeper validationHeadlineMinWeeks bar; until then the fully-backfilled
  // LEG_B reconstruction (which is what the TipRanks work actually improved)
  // stays the headline. Both variants ship in the payload regardless, so the
  // tab shows them side by side rather than silently switching.
  const headline = fullComposite?.sufficientHeadline ? fullComposite : legBComposite ?? fullComposite;
  const icSource: ValidationPayload["icSource"] = headline
    ? headline === fullComposite
      ? "FULL"
      : "LEG_B"
    : null;
  let regime: ValidationPayload["regime"] = null;
  let icCurrent: number | null = null;
  let icLongRun: number | null = null;
  if (headline) {
    const rolling = headline.rollingIC4w;
    icCurrent = rolling.length ? rolling[rolling.length - 1]!.ic : null;
    const tail = headline.weeklyIC.slice(-t.icLongRunWeeks);
    icLongRun = icSummary(tail.map((w) => w.ic)).mean;
    const finite = tail.filter((w) => w.ic !== null);
    regime = {
      positiveWeeks: finite.filter((w) => (w.ic ?? 0) > 0).length,
      totalWeeks: finite.length,
      window: t.icLongRunWeeks,
    };
  }

  const latestScore = await prisma.revisionScore.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const snapshotDate = latestScore?.snapshotDate ?? (grid.dates.length ? new Date(`${grid.dates[grid.dates.length - 1]}T00:00:00Z`) : new Date());

  const payload: ValidationPayload = {
    snapshotDate: isoOf(snapshotDate),
    generatedAt: new Date().toISOString(),
    horizonWeeks: horizon,
    minWeeks: t.validationMinWeeks,
    effectiveWeeks: {
      full: fullComposite?.effectiveWeeks ?? 0,
      legB: legBComposite?.effectiveWeeks ?? 0,
      price: grid.dates.length,
    },
    fullComposite,
    legBComposite,
    perSignal,
    postFlagDrift: {
      horizonsWeeks: horizons,
      newLong: longDrift.drift,
      newShort: shortDrift.drift,
      longFlags: longDrift.count,
      shortFlags: shortDrift.count,
    },
    regime,
    icCurrent,
    icLongRun,
    icSource,
    ptPanel,
  };

  await prisma.revisionAnalyticsSnapshot.upsert({
    where: { kind_snapshotDate: { kind: "validation", snapshotDate } },
    create: { kind: "validation", snapshotDate, payloadJson: payload as unknown as Prisma.InputJsonValue },
    update: { payloadJson: payload as unknown as Prisma.InputJsonValue, computedAt: new Date() },
  });
  log(
    `[validation] cached: full ${payload.effectiveWeeks.full}w, legB ${payload.effectiveWeeks.legB}w, price ${payload.effectiveWeeks.price}w, IC(${icSource}) ${icCurrent?.toFixed(3) ?? "n/a"}`,
  );
  return payload;
}

/** Latest cached validation payload, or null. */
export async function getLatestValidation(): Promise<ValidationPayload | null> {
  const row = await prisma.revisionAnalyticsSnapshot.findFirst({
    where: { kind: "validation" },
    orderBy: { snapshotDate: "desc" },
    select: { payloadJson: true },
  });
  return (row?.payloadJson as unknown as ValidationPayload) ?? null;
}
