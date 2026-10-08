/**
 * Engine 1 — materializes RevisionScreenRow + RevisionUniverseWeek, the ONE
 * table the three screens read.
 *
 * Runs after RevisionScore on the same (ticker, snapshotDate) key. The rank
 * itself comes from revision-rank.service, so the live queue, the backfilled
 * history and the signal lab all read one definition; everything else on the
 * row is a raw display column (counts, consensus changes, price z) that is
 * never blended into the rank.
 *
 * Point-in-time honesty: market cap and the Engine 2/3/4 tags have no weekly
 * history (those engines only keep a latest payload), so they are written for
 * the live week and left null on backfilled grid weeks rather than stamping
 * today's state onto 2024.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import { decomposeComposites } from "@/lib/revision/derived";
import {
  consecutiveAtDecile,
  decileChurn,
  likeForLikeChange,
  subsectorBreadth,
  subsectorMeans,
  zHistogram,
} from "@/lib/revision/screen-rows";
import { CONFLUENCE_THRESHOLDS, FLOW_LONG_STAGES, FLOW_SHORT_STAGE } from "@/lib/analysis/confluence/config";
import { readPerStockGridCache } from "@/server/services/factor-per-stock-cache.service";
import { reconstructSeries, type TickerSeries } from "./legb-weekly.service";
import { loadWeeklyGrid } from "./price-ingest.service";
import { computeWeekRanks, loadMarketCaps, loadRankRefs, type WeekRank } from "./revision-rank.service";
import { extractForwardFiscalDate, extractPeriodAvgs } from "./revision-scoring.service";

const DAY_MS = 86_400_000;
/** Sparkline depth on the queue row (grid weeks). */
const HIST_WEEKS = 13;
/** Decile strip depth on the queue row. */
const DECILE_HIST_WEEKS = 6;
/** Grid steps back the breadth heatmap's arrow compares against. */
const BREADTH_LOOKBACK = 4;

export interface ScreenRowsOptions {
  /** Grid weeks to write. Defaults to the latest grid date only. */
  snapshotDates?: string[];
  /** Write every grid week (the 143-week backfill). */
  all?: boolean;
  log?: (msg: string) => void;
}

export interface ScreenRowsSummary {
  weeks: number;
  rowsWritten: number;
  universeWeeks: number;
  taggedWeek: string | null;
}

// ─── Engine 2/3/4 tags (latest payloads only — see the file header) ─────────

interface EngineTags {
  e2: Map<string, string>;
  e3: Map<string, string>;
  e4: Map<string, string>;
}

/** Factor codes we are willing to name as a style driver, in tag order. */
const E4_FACTORS = [
  { code: "MOM", tag: "MOM+" },
  { code: "HML", tag: "VAL" },
  { code: "QMJ", tag: "QUAL" },
] as const;
/** Share of a stock's variance a style factor must explain before we name it. */
const E4_MIN_RISK_SHARE = 0.1;

async function loadEngineTags(): Promise<EngineTags> {
  const t = CONFLUENCE_THRESHOLDS;
  const e2 = new Map<string, string>();
  const e3 = new Map<string, string>();
  const e4 = new Map<string, string>();

  const discovery = await prisma.discoveryQueueSnapshot
    .findFirst({ orderBy: { snapshotDate: "desc" }, select: { payloadJson: true } })
    .catch(() => null);
  const dRows = (discovery?.payloadJson as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? [];
  for (const r of dRows) {
    if (typeof r.ticker !== "string") continue;
    const decile = (typeof r.subsectorDecile === "number" ? r.subsectorDecile : null) ??
      (typeof r.sectorDecile === "number" ? r.sectorDecile : null);
    const flags = Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === "string") : [];
    if (r.trapFlag === true) e2.set(r.ticker, "TRAP");
    else if (decile !== null && decile >= t.fundLongMinDecile) e2.set(r.ticker, "INFLECT");
    else if (flags.some((f) => f.toUpperCase().includes("COMPOUNDER"))) e2.set(r.ticker, "QUAL");
  }

  const latestFiling = await prisma.fundBookSnapshot
    .findFirst({ orderBy: { filingPeriod: "desc" }, select: { filingPeriod: true } })
    .catch(() => null);
  if (latestFiling) {
    const flows = await prisma.institutionalNameAggregate
      .findMany({
        where: { filingPeriod: latestFiling.filingPeriod },
        select: { ticker: true, netflowBps: true, lifecycleStage: true, crowded: true },
      })
      .catch(() => []);
    for (const f of flows) {
      if (f.crowded) e3.set(f.ticker, "CROWDED");
      else if (
        (f.netflowBps !== null && f.netflowBps >= t.flowLongMinBps) ||
        (f.lifecycleStage !== null && FLOW_LONG_STAGES.includes(f.lifecycleStage))
      )
        e3.set(f.ticker, "ACCUM");
      else if (
        (f.netflowBps !== null && f.netflowBps <= t.flowShortMaxBps) ||
        f.lifecycleStage === FLOW_SHORT_STAGE
      )
        e3.set(f.ticker, "DISTRIB");
    }
  }

  const grid = await readPerStockGridCache("MACRO14", 252).catch(() => null);
  for (const row of grid?.rows ?? []) {
    let best: { tag: string; share: number } | null = null;
    for (const f of E4_FACTORS) {
      const share = row.cells[f.code]?.riskContribution ?? 0;
      if (share >= E4_MIN_RISK_SHARE && (best === null || share > best.share))
        best = { tag: f.tag, share };
    }
    if (best) e4.set(row.ticker, best.tag);
  }

  return { e2, e3, e4 };
}

// ─── Leg-A consensus changes (like-for-like, 4 grid weeks) ──────────────────

interface LegASnapshot {
  eps: number | null;
  revenue: number | null;
  fiscalDate: string | null;
  periodAvgs: Map<string, { revenue?: number | null; eps?: number | null }>;
  nextEarningsDate: Date | null;
}

async function loadLegABy(dates: Date[]): Promise<Map<number, Map<string, LegASnapshot>>> {
  const out = new Map<number, Map<string, LegASnapshot>>();
  if (dates.length === 0) return out;
  const rows = await prisma.revisionSnapshot.findMany({
    where: { snapshotDate: { in: dates } },
    select: {
      ticker: true,
      snapshotDate: true,
      epsAvg: true,
      revenueAvg: true,
      estimatesJson: true,
      nextEarningsDate: true,
    },
  });
  for (const r of rows) {
    const k = r.snapshotDate.getTime();
    let m = out.get(k);
    if (!m) {
      m = new Map();
      out.set(k, m);
    }
    m.set(r.ticker, {
      eps: r.epsAvg === null ? null : Number(r.epsAvg),
      revenue: r.revenueAvg === null ? null : Number(r.revenueAvg),
      fiscalDate: extractForwardFiscalDate(r.estimatesJson),
      periodAvgs: extractPeriodAvgs(r.estimatesJson),
      nextEarningsDate: r.nextEarningsDate,
    });
  }
  return out;
}

function periodMap(
  snap: LegASnapshot | undefined,
  metric: "eps" | "revenue",
): Map<string, number | null> | null {
  if (!snap) return null;
  const out = new Map<string, number | null>();
  for (const [fiscalDate, avgs] of snap.periodAvgs) out.set(fiscalDate, avgs[metric] ?? null);
  return out;
}

// ─── the writer ─────────────────────────────────────────────────────────────

export async function buildScreenRows(opts: ScreenRowsOptions = {}): Promise<ScreenRowsSummary> {
  const log = opts.log ?? (() => {});
  const grid = await loadWeeklyGrid(REVISION_THRESHOLDS.priceBackfillWeeks);
  if (grid.length === 0) {
    log("[screen-rows] no grid dates present");
    return { weeks: 0, rowsWritten: 0, universeWeeks: 0, taggedWeek: null };
  }

  const targets = opts.all
    ? grid
    : (opts.snapshotDates ?? [grid[grid.length - 1]!]).filter((d) => grid.includes(d));
  if (targets.length === 0) {
    log("[screen-rows] no requested date is on the grid; nothing to write");
    return { weeks: 0, rowsWritten: 0, universeWeeks: 0, taggedWeek: null };
  }

  // Ranks need HIST_WEEKS of lead-in for the sparkline + streak columns, and
  // BREADTH_LOOKBACK for the heatmap arrow.
  const firstIdx = grid.indexOf(targets[0]!);
  const leadIn = Math.max(HIST_WEEKS, BREADTH_LOOKBACK + 1);
  const rankGrid = grid.slice(Math.max(0, firstIdx - leadIn), grid.indexOf(targets[targets.length - 1]!) + 1);
  const rankDates = rankGrid.map((d) => new Date(`${d}T00:00:00Z`));

  const refs = await loadRankRefs();
  const [ranks, caps, tags] = await Promise.all([
    computeWeekRanks(rankDates, refs),
    loadMarketCaps(),
    loadEngineTags(),
  ]);
  const rankByDate = new Map<string, WeekRank>();
  ranks.forEach((r, i) => rankByDate.set(rankGrid[i]!, r));
  log(`[screen-rows] ranked ${rankGrid.length} grid weeks (${rankGrid[0]} .. ${rankGrid[rankGrid.length - 1]})`);

  // Raw event counts over the same window (one chunked replay of the deduped
  // TipRanks ∪ FMP panel — the same primitive the Leg-B weekly write uses).
  const tickers = [...refs.keys()];
  const series: Map<string, TickerSeries> = await reconstructSeries(tickers, rankGrid, log);

  // Leg A only exists on scored weeks; a 4-week-prior snapshot is required for
  // the consensus-change columns, so pull both ends of every target week.
  const legADateSet = new Set<string>();
  for (const d of targets) {
    legADateSet.add(d);
    const i = grid.indexOf(d);
    if (i >= BREADTH_LOOKBACK) legADateSet.add(grid[i - BREADTH_LOOKBACK]!);
  }
  const legABy = await loadLegABy([...legADateSet].map((d) => new Date(`${d}T00:00:00Z`)));

  const liveWeek = grid[grid.length - 1]!;
  let rowsWritten = 0;
  let universeWeeks = 0;

  for (const dateIso of targets) {
    const gi = grid.indexOf(dateIso);
    const ri = rankGrid.indexOf(dateIso);
    const week = rankByDate.get(dateIso)!;
    const snapshotDate = new Date(`${dateIso}T00:00:00Z`);
    const isLive = dateIso === liveWeek;
    const legA = legABy.get(snapshotDate.getTime());
    const priorLegA =
      gi >= BREADTH_LOOKBACK
        ? legABy.get(new Date(`${grid[gi - BREADTH_LOOKBACK]!}T00:00:00Z`).getTime())
        : undefined;

    // grp / idio of the rank on the universe scale (the peer z is ~zero-mean
    // inside every bucket, so only the global scale decomposes).
    const peerKeys = week.entries.map((e) => e.peer.peerGroupKey);
    const decomp = decomposeComposites(
      week.entries.map((e) => e.ptRevOrthGlobalZ),
      peerKeys,
    );

    const data: Prisma.RevisionScreenRowCreateManyInput[] = week.entries.map((e, i) => {
      const s = series.get(e.ticker);
      const histStart = Math.max(0, ri - (HIST_WEEKS - 1));
      const zHist: number[] = [];
      const decHist: number[] = [];
      for (let w = histStart; w <= ri; w++) {
        const prev = rankByDate.get(rankGrid[w]!)?.byTicker.get(e.ticker);
        zHist.push(prev?.ptRevOrthZ ?? 0);
      }
      for (let w = Math.max(0, ri - (DECILE_HIST_WEEKS - 1)); w <= ri; w++) {
        const prev = rankByDate.get(rankGrid[w]!)?.byTicker.get(e.ticker);
        decHist.push(prev?.decile ?? 0);
      }
      const priorDecile = ri > 0 ? rankByDate.get(rankGrid[ri - 1]!)?.byTicker.get(e.ticker)?.decile ?? null : null;

      const curLegA = legA?.get(e.ticker);
      const epsChg = likeForLikeChange(
        curLegA?.eps ?? null,
        curLegA?.fiscalDate ?? null,
        periodMap(priorLegA?.get(e.ticker), "eps"),
      );
      const revChg = likeForLikeChange(
        curLegA?.revenue ?? null,
        curLegA?.fiscalDate ?? null,
        periodMap(priorLegA?.get(e.ticker), "revenue"),
      );
      const er = curLegA?.nextEarningsDate ?? null;
      const daysToEarnings = er
        ? Math.max(0, Math.round((er.getTime() - snapshotDate.getTime()) / DAY_MS))
        : null;

      return {
        ticker: e.ticker,
        snapshotDate,
        subsector: e.subsector ?? e.sector ?? "Unclassified",
        sector: e.sector ?? "Unclassified",
        mktCap: isLive ? caps.get(e.ticker) ?? null : null,
        analystCount: s?.ptPanelSize[ri] ?? 0,
        ptRevOrthZ: e.ptRevOrthZ,
        ptRevOrthRaw: e.ptRevOrthRaw,
        ptUp: s?.ptUp[ri] ?? 0,
        ptDown: s?.ptDown[ri] ?? 0,
        epsFy1Chg4w: epsChg,
        revFy1Chg4w: revChg,
        ratingUp: s?.ratingUp[ri] ?? 0,
        ratingDown: s?.ratingDown[ri] ?? 0,
        ratingInit: s?.ratingInit[ri] ?? 0,
        pxZ: e.pxZ,
        gap: e.gap,
        decile: e.decile,
        weeksInTopDecile:
          e.decile === 10
            ? consecutiveAtDecile(decHist, 10)
            : e.decile === 1
              ? consecutiveAtDecile(decHist, 1)
              : 0,
        ptRevOrthZHist: zHist,
        decileHist: decHist,
        isNewTop: e.decile === 10 && priorDecile !== 10,
        isNewBottom: e.decile === 1 && priorDecile !== 1,
        daysToEarnings,
        grpZ: decomp.groupZ[i] ?? null,
        idioZ: decomp.idioZ[i] ?? null,
        e2Tag: isLive ? tags.e2.get(e.ticker) ?? null : null,
        e3Tag: isLive ? tags.e3.get(e.ticker) ?? null : null,
        e4Tag: isLive ? tags.e4.get(e.ticker) ?? null : null,
      };
    });

    await prisma.$transaction([
      prisma.revisionScreenRow.deleteMany({ where: { snapshotDate } }),
      prisma.revisionScreenRow.createMany({ data }),
    ]);
    rowsWritten += data.length;

    // ---- universe strip ----
    const covered = data.filter((r) => (r.analystCount ?? 0) > 0);
    const netUp = covered.filter((r) => (r.ptUp ?? 0) > (r.ptDown ?? 0)).length;
    const curTop = new Set(data.filter((r) => r.decile === 10).map((r) => r.ticker));
    const curBottom = new Set(data.filter((r) => r.decile === 1).map((r) => r.ticker));
    const prevWeek = ri > 0 ? rankByDate.get(rankGrid[ri - 1]!) : null;
    const prevTop = new Set((prevWeek?.entries ?? []).filter((e) => e.decile === 10).map((e) => e.ticker));
    const prevBottom = new Set((prevWeek?.entries ?? []).filter((e) => e.decile === 1).map((e) => e.ticker));
    const topChurn = decileChurn(prevTop, curTop);
    const bottomChurn = decileChurn(prevBottom, curBottom);

    const curMeans = subsectorMeans(
      week.entries.map((e) => ({
        subsector: e.subsector ?? e.sector ?? "Unclassified",
        value: e.ptRevOrthGlobalZ,
      })),
    );
    const priorWeekRank = ri >= BREADTH_LOOKBACK ? rankByDate.get(rankGrid[ri - BREADTH_LOOKBACK]!) : null;
    const priorMeans = priorWeekRank
      ? subsectorMeans(
          priorWeekRank.entries.map((e) => ({
            subsector: e.subsector ?? e.sector ?? "Unclassified",
            value: e.ptRevOrthGlobalZ,
          })),
        )
      : null;

    const universeFields = {
      pctNamesNetUp: covered.length > 0 ? netUp / covered.length : null,
      ptUpTotal: data.reduce((a, r) => a + (r.ptUp ?? 0), 0),
      ptDownTotal: data.reduce((a, r) => a + (r.ptDown ?? 0), 0),
      revZHistogram: zHistogram(week.entries.map((e) => e.ptRevOrthZ)),
      arrivals: topChurn.arrivals,
      exits: topChurn.exits,
      arrivalsShort: bottomChurn.arrivals,
      exitsShort: bottomChurn.exits,
      namesScored: week.rankedN,
      subsectorsJson: subsectorBreadth(curMeans, priorMeans) as unknown as Prisma.InputJsonValue,
    };
    await prisma.revisionUniverseWeek.upsert({
      where: { snapshotDate },
      create: { snapshotDate, ...universeFields },
      update: universeFields,
    });
    universeWeeks++;

    if (universeWeeks % 10 === 0 || targets.length <= 3)
      log(`[screen-rows] ${dateIso}: ${data.length} rows (${universeWeeks}/${targets.length})`);
  }

  log(`[screen-rows] wrote ${rowsWritten} rows over ${targets.length} weeks`);
  return {
    weeks: targets.length,
    rowsWritten,
    universeWeeks,
    taggedWeek: targets.includes(liveWeek) ? liveWeek : null,
  };
}

/** Weekly incremental: write the pipeline's snapshot date only. */
export async function appendScreenRowsWeek(
  snapshotDate: string,
  log?: (msg: string) => void,
): Promise<ScreenRowsSummary> {
  return buildScreenRows({ snapshotDates: [snapshotDate], log });
}
