/**
 * Engine 1 — point-in-time weekly Leg-B reconstruction into RevisionLegBWeekly.
 *
 * Replays the backfilled RatingEvent + price-target event history onto the
 * weekly grid (DB-only — zero FMP calls): per ticker a net upgrade/downgrade
 * score and a reconstructed PT panel per week, then per week a cross-sectional
 * peer-group z-blend of {netUpDown, ptRevisionRecon} into a 2-signal Leg-B
 * composite. Gives streaks + validation stats full history while Leg A accrues.
 *
 * Price targets come from the deduped UNION of TipRanksRatingEvent (paid
 * add-on, dense, per-analyst expertUID) and PriceTargetEvent (free FMP feed,
 * sparse, firm-level) — see lib/revision/pt-sources. The revision signal is
 * matched-panel (analysts in both weeks), so a source going dark at a
 * subscription boundary changes panel SIZE (surfaced via ptPanelSize /
 * ptSourceMix) but cannot by itself move the signal.
 *
 * Peer groups use TODAY's RevisionReference taxonomy (documented limitation —
 * no historical sector membership exists). Idempotent per (ticker, snapshotDate).
 */
import { prisma } from "@/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  ptConsensusFromPanels,
  ptMoveCounts,
  ptPanelStats,
  ptRevisionMatched,
  reconstructPtPanels,
  weeklyActionCounts,
  weeklyNetActions,
  type PtEventLike,
} from "@/lib/revision/legb-history";
import { meshPtSources, type SourcedPtEvent } from "@/lib/revision/pt-sources";
import { compositeScores, zScores } from "@/lib/revision/scoring";
import { resolvePeerGroups, type RefClassification } from "@/lib/revision/aggregate";
import { loadWeeklyGrid } from "./price-ingest.service";

const DAY_MS = 86_400_000;
const TICKER_CHUNK = 200;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface TickerSeries {
  netUpDown: number[];
  ratingActivity: number[];
  ptConsensusRecon: Array<number | null>;
  ptRevisionRecon: Array<number | null>;
  ptPanelSize: number[];
  ptPanelMatched: number[];
  ptSourceMix: Array<number | null>;
  /** Display-only raw counts (not persisted on RevisionLegBWeekly; the screen rows read them). */
  ptUp: number[];
  ptDown: number[];
  ratingUp: number[];
  ratingDown: number[];
  ratingInit: number[];
}

export interface PriceTargetEventLoadOptions {
  /** Ignore TipRanks rows dated AFTER this ISO date (simulates a subscription lapse — seam QC). */
  tipranksCutoff?: string;
  /** Skip the TipRanks table entirely (FMP-only reconstruction — A/B baseline). */
  excludeTipranks?: boolean;
}

/**
 * Deduped-union price-target events per ticker over [from, to], keyed for
 * reconstruction. Always reads both tables; a lapsed TipRanks subscription
 * simply means the TipRanks side stops growing.
 */
export async function loadPriceTargetEvents(
  tickers: string[],
  from: Date,
  to: Date,
  opts: PriceTargetEventLoadOptions = {},
): Promise<Map<string, { events: PtEventLike[]; droppedFmp: number }>> {
  const [fmpRows, trRows] = await Promise.all([
    prisma.priceTargetEvent.findMany({
      where: { ticker: { in: tickers }, publishedDate: { gte: from, lte: to }, priceTarget: { not: null } },
      select: { ticker: true, publishedDate: true, analystCompany: true, priceTarget: true },
    }),
    opts.excludeTipranks
      ? Promise.resolve([])
      : prisma.tipRanksRatingEvent.findMany({
          where: {
            ticker: { in: tickers },
            ratingDate: {
              gte: from,
              lte: opts.tipranksCutoff ? new Date(`${opts.tipranksCutoff}T23:59:59Z`) : to,
            },
            priceTarget: { not: null },
          },
          select: { ticker: true, ratingDate: true, expertUID: true, firmName: true, priceTarget: true },
        }),
  ]);
  const fmpBy = new Map<string, SourcedPtEvent[]>();
  for (const r of fmpRows) {
    const e: SourcedPtEvent = {
      dateIso: isoOf(r.publishedDate),
      priceTarget: Number(r.priceTarget),
      source: "FMP",
      expertUID: null,
      firm: r.analystCompany,
    };
    const arr = fmpBy.get(r.ticker);
    if (arr) arr.push(e);
    else fmpBy.set(r.ticker, [e]);
  }
  const trBy = new Map<string, SourcedPtEvent[]>();
  for (const r of trRows) {
    const e: SourcedPtEvent = {
      dateIso: isoOf(r.ratingDate),
      priceTarget: Number(r.priceTarget),
      source: "TIPRANKS",
      expertUID: r.expertUID,
      firm: r.firmName,
    };
    const arr = trBy.get(r.ticker);
    if (arr) arr.push(e);
    else trBy.set(r.ticker, [e]);
  }
  const out = new Map<string, { events: PtEventLike[]; droppedFmp: number }>();
  for (const ticker of tickers) {
    const meshed = meshPtSources(trBy.get(ticker) ?? [], fmpBy.get(ticker) ?? []);
    out.set(ticker, meshed);
  }
  return out;
}

/** Reconstruct all tickers' weekly Leg-B series over the grid (chunked event reads). */
export async function reconstructSeries(
  tickers: string[],
  grid: string[],
  log: (msg: string) => void,
  loadOpts: PriceTargetEventLoadOptions = {},
): Promise<Map<string, TickerSeries>> {
  const out = new Map<string, TickerSeries>();
  // PT recon at grid[0] can see back staleDays; fetch a margin beyond that.
  const eventsFrom = new Date(
    new Date(`${grid[0]}T00:00:00Z`).getTime() - (REVISION_THRESHOLDS.ptReconStaleDays + 14) * DAY_MS,
  );
  const gridEnd = new Date(`${grid[grid.length - 1]}T23:59:59Z`);
  let droppedFmpTotal = 0;

  for (let i = 0; i < tickers.length; i += TICKER_CHUNK) {
    const chunk = tickers.slice(i, i + TICKER_CHUNK);
    const [ratings, targets] = await Promise.all([
      prisma.ratingEvent.findMany({
        where: { ticker: { in: chunk }, eventDate: { gte: eventsFrom, lte: gridEnd } },
        select: { ticker: true, eventDate: true, action: true },
      }),
      loadPriceTargetEvents(chunk, eventsFrom, gridEnd, loadOpts),
    ]);
    const ratingsByTicker = new Map<string, Array<{ dateIso: string; action: string | null }>>();
    for (const r of ratings) {
      const arr = ratingsByTicker.get(r.ticker);
      const e = { dateIso: isoOf(r.eventDate), action: r.action };
      if (arr) arr.push(e);
      else ratingsByTicker.set(r.ticker, [e]);
    }
    for (const ticker of chunk) {
      const net = weeklyNetActions(ratingsByTicker.get(ticker) ?? [], grid);
      const pt = targets.get(ticker) ?? { events: [], droppedFmp: 0 };
      droppedFmpTotal += pt.droppedFmp;
      const panels = reconstructPtPanels(pt.events, grid);
      const matched = ptRevisionMatched(panels);
      const stats = ptPanelStats(panels);
      const moves = ptMoveCounts(panels);
      const actions = weeklyActionCounts(ratingsByTicker.get(ticker) ?? [], grid);
      out.set(ticker, {
        netUpDown: net.map((w) => w.net),
        ratingActivity: net.map((w) => w.count),
        ptConsensusRecon: ptConsensusFromPanels(panels),
        ptRevisionRecon: matched.map((m) => m.revision),
        ptPanelSize: stats.map((s) => s.size),
        ptPanelMatched: matched.map((m) => m.matched),
        ptSourceMix: stats.map((s) => s.sourceMix),
        ptUp: moves.map((m) => m.up),
        ptDown: moves.map((m) => m.down),
        ratingUp: actions.map((a) => a.up),
        ratingDown: actions.map((a) => a.down),
        ratingInit: actions.map((a) => a.init),
      });
    }
    log(`[legb-weekly] reconstructed ${Math.min(i + TICKER_CHUNK, tickers.length)}/${tickers.length} tickers`);
  }
  log(`[legb-weekly] cross-source dedup dropped ${droppedFmpTotal} FMP rows already present in TipRanks`);
  return out;
}

/**
 * Cross-sectional composite per week: z-score each signal within its peer
 * bucket, equal-weight the available z's. netUpDown weeks with no events are
 * real zeros; ptRevisionRecon is null where no consensus change is observable.
 */
function weeklyComposites(
  tickers: string[],
  series: Map<string, TickerSeries>,
  peers: Map<string, { peerGroupKey: string }>,
  weekIdx: number,
): Array<number | null> {
  const buckets = new Map<string, number[]>();
  tickers.forEach((t, i) => {
    const k = peers.get(t)?.peerGroupKey ?? "Unclassified";
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });
  const signals: Array<{ key: string; of: (s: TickerSeries) => number | null }> = [
    { key: "netUpDown", of: (s) => s.netUpDown[weekIdx] ?? null },
    { key: "ptRevisionRecon", of: (s) => s.ptRevisionRecon[weekIdx] ?? null },
  ];
  const zMaps: Array<{ key: string; z: Map<number, number> }> = [];
  for (const sig of signals) {
    const global = new Map<number, number>();
    for (const idxs of buckets.values()) {
      const sub = idxs.map((i) => {
        const s = series.get(tickers[i]!);
        return s ? sig.of(s) : null;
      });
      const { z } = zScores(sub);
      for (const [localIdx, zv] of z) global.set(idxs[localIdx]!, zv);
    }
    zMaps.push({ key: sig.key, z: global });
  }
  return compositeScores(zMaps, tickers.length);
}

async function loadPeerGroups(tickers: string[]): Promise<Map<string, { peerGroupKey: string }>> {
  const refs = await prisma.revisionReference.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, sector: true, subsector: true },
  });
  const classifications: RefClassification[] = refs.map((r) => ({
    ticker: r.ticker,
    sector: r.sector,
    subsector: r.subsector,
  }));
  return resolvePeerGroups(classifications);
}

export interface LegBWeeklySummary {
  tickers: number;
  weeks: number;
  rowsWritten: number;
}

/** Full-history backfill (re-runnable; skipDuplicates unless refresh). */
export async function backfillLegBWeekly(
  opts: { extendWeeks?: number; tickers?: string[]; refresh?: boolean; log?: (msg: string) => void } = {},
): Promise<LegBWeeklySummary> {
  const log = opts.log ?? (() => {});
  const grid = await loadWeeklyGrid(opts.extendWeeks ?? REVISION_THRESHOLDS.priceBackfillWeeks);
  if (grid.length === 0) {
    log("[legb-weekly] no snapshot dates present; nothing to backfill");
    return { tickers: 0, weeks: 0, rowsWritten: 0 };
  }
  const tickers =
    opts.tickers ??
    (await prisma.revisionReference.findMany({ where: { isActive: true }, select: { ticker: true } })).map(
      (r) => r.ticker,
    );
  const series = await reconstructSeries(tickers, grid, log);
  const peers = await loadPeerGroups(tickers);

  let rowsWritten = 0;
  for (let w = 0; w < grid.length; w++) {
    const composites = weeklyComposites(tickers, series, peers, w);
    const snapshotDate = new Date(`${grid[w]}T00:00:00Z`);
    const data = tickers.map((ticker, i) => {
      const s = series.get(ticker)!;
      return {
        ticker,
        snapshotDate,
        netUpDown: s.netUpDown[w] ?? null,
        ratingActivity: s.ratingActivity[w] ?? null,
        ptConsensusRecon: s.ptConsensusRecon[w] ?? null,
        ptRevisionRecon: s.ptRevisionRecon[w] ?? null,
        composite: composites[i] ?? null,
        ptPanelSize: s.ptPanelSize[w] ?? null,
        ptPanelMatched: s.ptPanelMatched[w] ?? null,
        ptSourceMix: s.ptSourceMix[w] ?? null,
      };
    });
    if (opts.refresh) {
      for (const d of data) {
        const { ticker, snapshotDate: sd, ...fields } = d;
        await prisma.revisionLegBWeekly.upsert({
          where: { ticker_snapshotDate: { ticker, snapshotDate: sd } },
          create: d,
          update: fields,
        });
      }
      rowsWritten += data.length;
    } else {
      const res = await prisma.revisionLegBWeekly.createMany({ data, skipDuplicates: true });
      rowsWritten += res.count;
    }
    if ((w + 1) % 20 === 0) log(`[legb-weekly] wrote week ${w + 1}/${grid.length}`);
  }
  log(`[legb-weekly] backfill wrote ${rowsWritten} rows over ${grid.length} weeks`);
  return { tickers: tickers.length, weeks: grid.length, rowsWritten };
}

/**
 * Incremental weekly append for one snapshot date: reconstruct just enough
 * trailing grid (PT staleness window) and upsert only that week's rows.
 */
export async function appendLegBWeek(
  opts: { snapshotDate: string; tickers?: string[]; log?: (msg: string) => void },
): Promise<LegBWeeklySummary> {
  const log = opts.log ?? (() => {});
  const fullGrid = await loadWeeklyGrid(REVISION_THRESHOLDS.priceBackfillWeeks);
  const upTo = fullGrid.filter((d) => d <= opts.snapshotDate);
  if (upTo.length === 0 || upTo[upTo.length - 1] !== opts.snapshotDate) {
    log(`[legb-weekly] ${opts.snapshotDate} is not on the snapshot grid; skipping append`);
    return { tickers: 0, weeks: 0, rowsWritten: 0 };
  }
  // Two trailing grid dates: the prior week anchors ptRevisionRecon.
  const grid = upTo.slice(Math.max(0, upTo.length - 2));
  const tickers =
    opts.tickers ??
    (await prisma.revisionReference.findMany({ where: { isActive: true }, select: { ticker: true } })).map(
      (r) => r.ticker,
    );
  const series = await reconstructSeries(tickers, grid, log);
  const peers = await loadPeerGroups(tickers);
  const w = grid.length - 1;
  const composites = weeklyComposites(tickers, series, peers, w);
  const snapshotDate = new Date(`${grid[w]}T00:00:00Z`);

  let rowsWritten = 0;
  for (let i = 0; i < tickers.length; i++) {
    const s = series.get(tickers[i]!)!;
    const fields = {
      netUpDown: s.netUpDown[w] ?? null,
      ratingActivity: s.ratingActivity[w] ?? null,
      ptConsensusRecon: s.ptConsensusRecon[w] ?? null,
      ptRevisionRecon: s.ptRevisionRecon[w] ?? null,
      composite: composites[i] ?? null,
      ptPanelSize: s.ptPanelSize[w] ?? null,
      ptPanelMatched: s.ptPanelMatched[w] ?? null,
      ptSourceMix: s.ptSourceMix[w] ?? null,
    };
    await prisma.revisionLegBWeekly.upsert({
      where: { ticker_snapshotDate: { ticker: tickers[i]!, snapshotDate } },
      create: { ticker: tickers[i]!, snapshotDate, ...fields },
      update: fields,
    });
    rowsWritten++;
  }
  log(`[legb-weekly] appended ${rowsWritten} rows for ${opts.snapshotDate}`);
  return { tickers: tickers.length, weeks: 1, rowsWritten };
}
