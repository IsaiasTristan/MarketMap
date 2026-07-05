/**
 * Engine 3 — read layer for the Flows dashboard views. All functions are
 * point-in-time (keyed by filing period) and return raw counts + the two visible
 * axes (breadth, conviction) — no composite scores. Interfaces here are the API
 * contract; the client type-imports them.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { CROWDED_BREADTH_PCT, signalFundFilter } from "./institutional-aggregate.service";
import { CATEGORY_TIER, type FundCategory } from "./watchlist";
import { getLeaderboard } from "./institutional-leaderboard.service";
import { UNCLASSIFIED_SECTOR } from "@/lib/institutional/security-class";
import { activeFlowFlags, type FlowFlagId } from "@/lib/institutional/flow-flags";
import { rankStockRotation, shrunkDiffusionPct, stockRankScore, diffusionContext, participationWeightedMean, rescaleScore0to100, dominantConcentration, type RankedStockRow, type StockRotationInput } from "@/lib/institutional/stock-rotation";
import { FLOW_LEADERBOARD_CONFIG } from "@/domain/calculations/flow-leaderboard-config";
import { accumulationStreak, cumulativeAccSeries, trajectoryRankScore } from "@/domain/calculations/flow-trajectory";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const HIGH_CONVICTION_PCT = 1; // % of book that marks a "real" position

// ── periods / meta ──────────────────────────────────────────────────────────
export async function listPeriods(): Promise<string[]> {
  const rows = await prisma.institutionalNameAggregate.findMany({
    distinct: ["filingPeriod"],
    select: { filingPeriod: true },
    orderBy: { filingPeriod: "desc" },
  });
  return rows.map((r) => iso(r.filingPeriod));
}

async function resolvePeriod(period?: string): Promise<string | null> {
  if (period) return period;
  const rows = await listPeriods();
  return rows[0] ?? null;
}

/** Tracked active funds that filed in a period (breadth denominator).
 *  NB: a raw date column must be compared with a ::date cast, not a JS Date
 *  parameter (which binds as a timestamp and silently fails to match). */
async function trackedFundsInPeriod(period: string): Promise<number> {
  // Signal-tier only, so the count matches the breadth denominator used to build
  // the aggregates and the leaderboard (see signalFundFilter — single source of truth).
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(DISTINCT h."fundId") AS n
    FROM "FundHoldingSnapshot" h
    WHERE h."filingPeriod" = ${period}::date AND h.shares > 0 AND ${signalFundFilter("h")}`);
  return Number(rows[0]?.n ?? 0);
}

/** Conviction line = median of positive median-%-of-book across funds≥2 names
 *  in the period. Matches the boundary used to store each name's `quadrant`. */
async function convictionLineForPeriod(periodDate: Date): Promise<number> {
  const rows = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: periodDate, fundsHolding: { gte: 2 }, medianPctOfBook: { gt: 0 } },
    select: { medianPctOfBook: true },
  });
  const vals = rows.map((r) => r.medianPctOfBook!).sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  // Same median definition the aggregate service uses for the stored quadrant
  // boundary (average the two middle values for even counts) so the displayed
  // conviction line coincides exactly with each point's stored quadrant color.
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m]! : (vals[m - 1]! + vals[m]!) / 2;
}

// ── 5.1 overview / landing ────────────────────────────────────────────────
export interface OverviewPayload {
  filingPeriod: string;
  priorPeriod: string | null;
  generatedAt: string;
  trackedFunds: number;
  tiles: {
    newAccumulation: number;
    newAccumulationDelta: number;
    newDistribution: number;
    newDistributionDelta: number;
    crowdingAlerts: number;
    smallMidShare: number;
  };
  topNew: Array<{
    ticker: string;
    companyName: string | null;
    sector: string | null;
    marketCapTier: string | null;
    fundsBought: number;
    fundsSold: number;
    pctOfFunds: number;
    deltaHolders: number;
  }>;
  // Rotation diffusion tiles — broadest sector inflow/outflow this quarter.
  // Optional: absent on snapshots cached before the active-flow redesign.
  rotation?: {
    broadestInflow: RotationTile | null;
    broadestOutflow: RotationTile | null;
  };
}
export interface RotationTile {
  groupKey: string;
  netDiffusionPct: number;
  activeBpsAvg: number;
  dollarNetFlow: number;
}

export async function getOverview(period?: string): Promise<OverviewPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const snap = await prisma.institutionalQuarterSnapshot.findUnique({ where: { filingPeriod: periodDate } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as Omit<OverviewPayload, "trackedFunds" | "priorPeriod">;
  const periods = await listPeriods();
  const idx = periods.indexOf(p);
  return {
    ...payload,
    trackedFunds: await trackedFundsInPeriod(p),
    priorPeriod: idx >= 0 && idx + 1 < periods.length ? periods[idx + 1]! : null,
  };
}

// ── 5.2 crowding-vs-conviction quadrant ─────────────────────────────────────
export interface QuadrantPoint {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  breadth: number; // % of tracked funds (x)
  conviction: number | null; // median % of book (y)
  deltaHolders: number; // bubble size
  holderStreak: number; // signed consecutive quarters of same-signed delta (+accum / −distrib)
  fundsHolding: number;
  fundsBought: number;
  fundsSold: number;
  quadrant: string | null;
  trajectoryLabel: string | null;
  /** Prior-quarter position for the QoQ trajectory trail; null if the name was
   *  not in the universe last quarter (entered this quarter → no trail). */
  prev: { breadth: number; conviction: number | null } | null;
  /** Data-quality flags joined from the SAME leaderboard rows the Leaderboard tab
   *  renders (parity — no view-local flag logic). Absent for names the leaderboard
   *  doesn't score. */
  verifyData?: boolean;
  partialData?: boolean;
}
/** Per-ticker elite-exit summary for the "elite leaving crowded" danger list. */
export interface QuadrantExitCluster {
  ticker: string;
  eliteExits: number;
  eliteSizing: number;
  convictionExits: number;
}
export interface QuadrantPayload {
  filingPeriod: string;
  priorPeriod: string | null;
  breadthLine: number;
  convictionLine: number;
  trackedFunds: number;
  points: QuadrantPoint[];
  /** Crowded-name elite exits (Part 4b); empty when there is no prior quarter. */
  exitClusters: QuadrantExitCluster[];
}

export async function getQuadrant(period?: string, minFunds = 2): Promise<QuadrantPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  // Prior quarter (index+1 in the desc period list) for trajectory trails.
  const periods = await listPeriods();
  const idx = periods.indexOf(p);
  const priorPeriod = idx >= 0 && idx + 1 < periods.length ? periods[idx + 1]! : null;

  const [rows, convictionLine, trackedFunds] = await Promise.all([
    prisma.institutionalNameAggregate.findMany({
      where: { filingPeriod: periodDate, fundsHolding: { gte: minFunds } },
      orderBy: { fundsHolding: "desc" },
    }),
    convictionLineForPeriod(periodDate),
    trackedFundsInPeriod(p),
  ]);

  // One batched lookup of the prior quarter's breadth/conviction for these
  // tickers (not N+1). A ticker with no prior-quarter row gets prev = null.
  const prevByTicker = new Map<string, { breadth: number; conviction: number | null }>();
  if (priorPeriod) {
    const priorRows = await prisma.institutionalNameAggregate.findMany({
      where: { filingPeriod: new Date(`${priorPeriod}T00:00:00.000Z`), ticker: { in: rows.map((r) => r.ticker) } },
      select: { ticker: true, pctOfFunds: true, medianPctOfBook: true },
    });
    for (const pr of priorRows) {
      prevByTicker.set(pr.ticker, {
        breadth: Number(pr.pctOfFunds.toFixed(2)),
        conviction: pr.medianPctOfBook !== null ? Number(pr.medianPctOfBook.toFixed(3)) : null,
      });
    }
  }

  // Data-quality flags come from the SAME leaderboard rows the Leaderboard tab
  // renders (parity — no view-local flag logic); crowded-name elite exits feed
  // the "elite leaving crowded" danger list. Both are best-effort: if the source
  // is unavailable for this period, names simply carry no flags / no clusters.
  const tickerSet = new Set(rows.map((r) => r.ticker));
  const flagByTicker = new Map<string, { verify: boolean; partial: boolean }>();
  let exitClusters: QuadrantExitCluster[] = [];
  await Promise.all([
    (async () => {
      try {
        const lb = await getLeaderboard(p);
        if (lb) for (const er of [...lb.accumulation, ...lb.distribution]) flagByTicker.set(er.ticker, { verify: er.verifyData, partial: er.partialData });
      } catch {
        /* leaderboard unavailable for this period */
      }
    })(),
    (async () => {
      try {
        const ec = await getExitClusters(p);
        if (ec) {
          exitClusters = ec.rows
            .filter((e) => e.eliteExits > 0 && tickerSet.has(e.ticker))
            .map((e) => ({ ticker: e.ticker, eliteExits: e.eliteExits, eliteSizing: Math.round(e.eliteSizing * 10) / 10, convictionExits: e.convictionExits }));
        }
      } catch {
        /* no prior quarter → no exit clusters */
      }
    })(),
  ]);

  return {
    filingPeriod: p,
    priorPeriod,
    breadthLine: CROWDED_BREADTH_PCT,
    convictionLine,
    trackedFunds,
    exitClusters,
    points: rows.map((r) => {
      const flags = flagByTicker.get(r.ticker);
      return {
        ticker: r.ticker,
        companyName: r.companyName,
        sector: r.sector,
        marketCapTier: r.marketCapTier,
        breadth: Number(r.pctOfFunds.toFixed(2)),
        conviction: r.medianPctOfBook !== null ? Number(r.medianPctOfBook.toFixed(3)) : null,
        deltaHolders: r.deltaHolders,
        holderStreak: r.holderStreak,
        fundsHolding: r.fundsHolding,
        fundsBought: r.fundsBought,
        fundsSold: r.fundsSold,
        quadrant: r.quadrant,
        trajectoryLabel: r.trajectoryLabel,
        prev: prevByTicker.get(r.ticker) ?? null,
        verifyData: flags?.verify,
        partialData: flags?.partial,
      };
    }),
  };
}

// ── 5.3 accumulation-trajectory small multiples ─────────────────────────────
export interface TrajectoryCard {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  latestHolders: number;
  deltaHolders: number;
  latestActiveBps: number | null; // this quarter's all-funds net move (bps of book)
  trajectoryLabel: string | null;
  /** Pattern rank score = streak × slope-consistency × breadth-growth (Part 1c). */
  rankScore: number;
  /** Signed accumulation streak ending at this quarter. */
  streak: number;
  series: Array<{ period: string; holders: number; cumActiveBps: number }>;
}
export interface TrajectoryGridPayload {
  filingPeriod: string;
  cards: TrajectoryCard[];
}

const TRAJECTORY_MIN_FUNDS = 3; // ignore names touched by < 3 funds (noise)

export async function getTrajectoryGrid(
  period?: string,
  limit = 12,
  sort: "pattern" | "delta" | "holders" = "pattern",
): Promise<TrajectoryGridPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = await listPeriods();
  const periodDate = new Date(`${p}T00:00:00.000Z`);

  // Candidate pool: names touched by ≥ TRAJECTORY_MIN_FUNDS this quarter. We rank
  // by trajectory SHAPE (Part 1c), not by the latest-quarter move, so we score the
  // whole pool and slice — never `orderBy activeBpsAvg desc`.
  const candidates = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: periodDate, fundsHolding: { gte: TRAJECTORY_MIN_FUNDS } },
    select: { ticker: true, companyName: true, sector: true, marketCapTier: true, fundsHolding: true, deltaHolders: true, netflowBps: true, trajectoryLabel: true },
  });
  const tickers = candidates.map((t) => t.ticker);

  // 8-quarter window ENDING at the selected period (periods is desc), not the
  // globally-latest 8 — otherwise a historical selection plots later quarters.
  const pIdx = Math.max(0, periods.indexOf(p));
  const window = periods.slice(pIdx, pIdx + 8).reverse(); // oldest→newest, ending at p
  const windowDates = window.map((w) => new Date(`${w}T00:00:00.000Z`));
  const series = tickers.length
    ? await prisma.institutionalNameAggregate.findMany({
        where: { ticker: { in: tickers }, filingPeriod: { in: windowDates } },
        select: { ticker: true, filingPeriod: true, fundsHolding: true, netflowBps: true },
      })
    : [];
  const byTicker = new Map<string, Map<string, { holders: number; bps: number }>>();
  for (const s of series) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, new Map());
    byTicker.get(s.ticker)!.set(iso(s.filingPeriod), { holders: s.fundsHolding, bps: s.netflowBps ?? 0 });
  }

  // Score every candidate by streak × slope-consistency × breadth-growth over the
  // SINGLE all-funds accumulation series. Rank desc, then slice.
  const scored = candidates.map((t) => {
    const perQuarterBps = window.map((w) => byTicker.get(t.ticker)?.get(w)?.bps ?? 0);
    const holdersByPeriod = window.map((w) => byTicker.get(t.ticker)?.get(w)?.holders ?? 0);
    const accSeries = cumulativeAccSeries(perQuarterBps);
    const streak = accumulationStreak(perQuarterBps);
    const streakLen = Math.abs(streak);
    const startIdx = Math.max(0, window.length - (streakLen + 1));
    const rank = trajectoryRankScore({
      accSeries,
      streakLength: streak,
      holdersStart: holdersByPeriod[startIdx] ?? holdersByPeriod[0] ?? 0,
      holdersNow: t.fundsHolding,
    });
    return { t, accSeries, holdersByPeriod, streak, rank };
  });

  const sorted =
    sort === "holders"
      ? scored.sort((a, b) => b.t.fundsHolding - a.t.fundsHolding)
      : sort === "delta"
        ? scored.sort((a, b) => b.t.deltaHolders - a.t.deltaHolders || b.t.fundsHolding - a.t.fundsHolding)
        : // pattern: durable builds first; break ties on positive-streak length then holders.
          scored.sort((a, b) => b.rank - a.rank || Math.abs(b.streak) - Math.abs(a.streak) || b.t.fundsHolding - a.t.fundsHolding);

  return {
    filingPeriod: p,
    cards: sorted.slice(0, limit).map(({ t, accSeries, holdersByPeriod, streak, rank }) => ({
      ticker: t.ticker,
      companyName: t.companyName,
      sector: t.sector,
      marketCapTier: t.marketCapTier,
      latestHolders: t.fundsHolding,
      deltaHolders: t.deltaHolders,
      latestActiveBps: t.netflowBps,
      trajectoryLabel: t.trajectoryLabel,
      rankScore: rank,
      streak,
      series: window.map((w, i) => ({ period: w, holders: holdersByPeriod[i] ?? 0, cumActiveBps: accSeries[i] ?? 0 })),
    })),
  };
}

// ── Trajectories pipeline (Part 5) ──────────────────────────────────────────
export interface DurableCard {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  streak: number;
  rankScore: number;
  holders: number;
  deltaHolders: number;
  breadth: number;
  periods: string[]; // aligned window, ascending
  accSeries: number[]; // cumulative accumulation (blue line)
  priceIndexed: Array<number | null>; // split-adjusted close indexed to 100 at window start (dashed)
  priceSincePeriodEnd: number | null; // % since the latest period-end
  eliteCount: number;
  topAdder: { fund: string; sizingMult: number; isElite: boolean } | null;
  evidenceChips: string[];
  actionTag: string;
  /** Data-quality flags from the shared registry (same glyphs as leaderboard/rotation). */
  flags?: FlowFlagId[];
  /** Mega-cap shown only because the cap filter includes mega — render dimmed
   *  "informational only" (Part 2c). */
  informational?: boolean;
}
/** A DURABLE/CORE-shaped build below the participation floor (n < min_participants) —
 *  a watch item, not a durable card (Part 2a). */
export interface WatchItem {
  ticker: string;
  companyName: string | null;
  streak: number;
  holders: number;
  flags?: FlowFlagId[];
}
export interface FormingChip {
  ticker: string;
  companyName: string | null;
  streak: number;
  eliteCount: number;
  qualifier: string;
  flags?: FlowFlagId[];
}
export interface SpikeLine {
  ticker: string;
  latestActiveBps: number | null;
  flags?: FlowFlagId[];
}
export interface TransitionItem {
  ticker: string;
  from: string | null;
  to: string | null;
  transition: string;
  significance: number;
}
export interface TrajectoryPipelinePayload {
  filingPeriod: string;
  census: Array<{ stage: string; count: number; deltaVsPrior: number }>;
  transitionsCount: number;
  durable: DurableCard[];
  forming: FormingChip[];
  /** Below-participation-floor builds (Part 2a) — surfaced as watch, never durable. */
  watch: WatchItem[];
  spikes: { count: number; items: SpikeLine[] };
  transitions: TransitionItem[];
  baseRates: { durable: string | null; forming: string | null };
}

const PIPELINE_WINDOW = 8;

/** Format a stored base-rate row into a header line (null-N-safe). */
function baseRateLine(row: { excessReturn: number | null; hitRate: number | null; n: number } | null, label: string, horizon = "2Q"): string | null {
  if (!row) return null;
  if (row.n < 30 || row.excessReturn == null) return `${label}: insufficient history (n=${row.n})`;
  const hit = row.hitRate != null ? `, ${Math.round(row.hitRate * 100)}% hit` : "";
  return `${label}: ${row.excessReturn >= 0 ? "+" : ""}${(row.excessReturn * 100).toFixed(1)}% excess next ${horizon} (n=${row.n}${hit})`;
}

export async function getTrajectoryPipeline(period?: string, durableLimit = 24, capFilter: RotationSizeFilter = "ex-mega"): Promise<TrajectoryPipelinePayload | null> {
  const includeMega = capFilter !== "ex-mega"; // Part 2c: mega-caps are ex'd from durable cards by default
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = await listPeriods(); // desc
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const pIdx = Math.max(0, periods.indexOf(p));
  const priorP = periods[pIdx + 1] ?? null; // prior quarter (periods is desc)

  // Names carrying a lifecycle stage this quarter.
  const staged = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: periodDate, lifecycleStage: { not: null } },
    select: { ticker: true, companyName: true, sector: true, marketCapTier: true, fundsHolding: true, deltaHolders: true, pctOfFunds: true, netflowBps: true, lifecycleStage: true, crowded: true },
  });

  // Stage census + QoQ deltas (Part 2d): counts come from the SAME filtered set the
  // sections render — DURABLE is ex-mega by default (Part 2c), so the chip equals the
  // number of cards shown. Mega durable names only count when includeMega.
  const shownInStage = (r: { lifecycleStage: string | null; marketCapTier: string | null }): boolean =>
    r.lifecycleStage != null && (r.lifecycleStage !== "DURABLE" || includeMega || r.marketCapTier !== "mega");
  const countBy = (rows: Array<{ lifecycleStage: string | null; marketCapTier: string | null }>) => {
    const m = new Map<string, number>();
    for (const r of rows) if (shownInStage(r)) m.set(r.lifecycleStage!, (m.get(r.lifecycleStage!) ?? 0) + 1);
    return m;
  };
  const curCounts = countBy(staged);
  const priorStaged = priorP
    ? await prisma.institutionalNameAggregate.findMany({ where: { filingPeriod: new Date(`${priorP}T00:00:00.000Z`), lifecycleStage: { not: null } }, select: { lifecycleStage: true, marketCapTier: true } })
    : [];
  const priorCounts = countBy(priorStaged);
  const census = ["DURABLE", "FORMING", "SPIKE", "WATCH", "CORE", "BROKEN"].map((stage) => ({
    stage,
    count: curCounts.get(stage) ?? 0,
    deltaVsPrior: (curCounts.get(stage) ?? 0) - (priorCounts.get(stage) ?? 0),
  }));

  // Window series (netflowBps + holders) for staged tickers.
  const window = periods.slice(pIdx, pIdx + PIPELINE_WINDOW).reverse(); // oldest→newest
  const windowDates = window.map((w) => new Date(`${w}T00:00:00.000Z`));
  const tickers = staged.map((s) => s.ticker);
  const series = tickers.length
    ? await prisma.institutionalNameAggregate.findMany({ where: { ticker: { in: tickers }, filingPeriod: { in: windowDates } }, select: { ticker: true, filingPeriod: true, fundsHolding: true, netflowBps: true } })
    : [];
  const seriesByTicker = new Map<string, Map<string, { holders: number; bps: number }>>();
  for (const s of series) {
    if (!seriesByTicker.has(s.ticker)) seriesByTicker.set(s.ticker, new Map());
    seriesByTicker.get(s.ticker)!.set(iso(s.filingPeriod), { holders: s.fundsHolding, bps: s.netflowBps ?? 0 });
  }

  const rankOf = (ticker: string, holdersNow: number) => {
    const perQuarterBps = window.map((w) => seriesByTicker.get(ticker)?.get(w)?.bps ?? 0);
    const accSeries = cumulativeAccSeries(perQuarterBps);
    const streak = accumulationStreak(perQuarterBps);
    const holdersByPeriod = window.map((w) => seriesByTicker.get(ticker)?.get(w)?.holders ?? 0);
    const startIdx = Math.max(0, window.length - (Math.abs(streak) + 1));
    const rank = trajectoryRankScore({ accSeries, streakLength: streak, holdersStart: holdersByPeriod[startIdx] ?? holdersByPeriod[0] ?? 0, holdersNow });
    return { accSeries, streak, rank, holdersByPeriod, startIdx };
  };

  // ── Shared data-quality flags (Part 1c) — same registry/glyphs as leaderboard & rotation. ──
  const flagMap = (await getLeaderboard(p))?.flagsByTicker ?? {};
  const splitHolds = await unresolvedSplitTickers(periodDate);
  const flagsFor = (ticker: string): FlowFlagId[] | undefined => {
    const ids = activeFlowFlags({ ...flagMap[ticker], unresolvedSplit: splitHolds.has(ticker) }).map((d) => d.id);
    return ids.length ? ids : undefined;
  };

  // ── DURABLE cards (full evidence). ── ex-mega by default (Part 2c).
  const durableRows = staged.filter((s) => s.lifecycleStage === "DURABLE" && (includeMega || s.marketCapTier !== "mega"));
  const durTickers = durableRows.map((r) => r.ticker);
  // Indexed split-adjusted price over the window + top qualified initiator.
  const priceByTicker = await indexedPriceByTicker(durTickers, window);
  const priceSinceByT = await priceSinceByTicker(durTickers, p);
  const topAdderByTicker = await topInitiatorByTicker(durTickers, p);
  const eliteByTicker = await eliteAdderCountByTicker(durTickers, p);

  const durable: DurableCard[] = durableRows
    .map((r) => {
      const { accSeries, streak, rank } = rankOf(r.ticker, r.fundsHolding);
      const priceIndexed = priceByTicker.get(r.ticker) ?? window.map(() => null);
      const lastPx = [...priceIndexed].reverse().find((x) => x != null) ?? null;
      // "% since period-end" = period-end → latest close (~1 quarter), NOT the full
      // 12q window return (the earlier firstPx→lastPx bug that produced +400% "since").
      const priceSincePeriodEnd = priceSinceByT.get(r.ticker) ?? null;
      const streakLen = Math.abs(streak);
      const startIdx = Math.max(0, window.length - (streakLen + 1));
      const priceOverStreak = priceIndexed[startIdx] != null && lastPx != null && priceIndexed[startIdx]! > 0 ? (lastPx / priceIndexed[startIdx]! - 1) * 100 : null;
      const top = topAdderByTicker.get(r.ticker) ?? null;
      const eliteCount = eliteByTicker.get(r.ticker) ?? 0;
      const chips = evidenceChips({ priceOverStreak, top, eliteCount, deltaHolders: r.deltaHolders, crowded: r.crowded });
      return {
        ticker: r.ticker,
        companyName: r.companyName,
        sector: r.sector,
        marketCapTier: r.marketCapTier,
        streak,
        rankScore: rank,
        holders: r.fundsHolding,
        deltaHolders: r.deltaHolders,
        breadth: Number(r.pctOfFunds.toFixed(2)),
        periods: window,
        accSeries,
        priceIndexed,
        priceSincePeriodEnd,
        eliteCount,
        topAdder: top,
        evidenceChips: chips,
        actionTag: r.crowded ? "crowded — confirm" : "add candidate",
        flags: flagsFor(r.ticker),
        informational: r.marketCapTier === "mega",
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, durableLimit);

  // ── FORMING chips. ──
  const forming: FormingChip[] = staged
    .filter((s) => s.lifecycleStage === "FORMING")
    .map((r) => {
      const { streak } = rankOf(r.ticker, r.fundsHolding);
      const eliteCount = 0;
      return {
        ticker: r.ticker,
        companyName: r.companyName,
        streak,
        eliteCount,
        qualifier: r.deltaHolders > 0 ? `+${r.deltaHolders} holders` : `${r.fundsHolding} funds`,
        flags: flagsFor(r.ticker),
      };
    })
    .sort((a, b) => Math.abs(b.streak) - Math.abs(a.streak));

  // ── WATCH (Part 2a): below-participation-floor durable-shaped builds, n=1 style. ──
  const watch: WatchItem[] = staged
    .filter((s) => s.lifecycleStage === "WATCH")
    .map((r) => ({ ticker: r.ticker, companyName: r.companyName, streak: rankOf(r.ticker, r.fundsHolding).streak, holders: r.fundsHolding, flags: flagsFor(r.ticker) }))
    .sort((a, b) => Math.abs(b.streak) - Math.abs(a.streak));

  // ── SPIKES (collapsed). ──
  const spikeRows = staged.filter((s) => s.lifecycleStage === "SPIKE");
  const spikes = {
    count: spikeRows.length,
    items: spikeRows
      .sort((a, b) => (b.netflowBps ?? 0) - (a.netflowBps ?? 0))
      .slice(0, 40)
      .map((r) => ({ ticker: r.ticker, latestActiveBps: r.netflowBps, flags: flagsFor(r.ticker) })),
  };

  // ── TRANSITIONS this quarter. ──
  const transEvents = await prisma.institutionalEvent.findMany({ where: { kind: "stage_transition", filingPeriod: periodDate }, orderBy: { significance: "desc" }, take: 60 });
  const transitions: TransitionItem[] = transEvents.map((e) => {
    const pl = e.payload as { from?: string | null; to?: string | null; transition?: string } | null;
    return { ticker: e.ticker, from: pl?.from ?? null, to: pl?.to ?? null, transition: pl?.transition ?? "", significance: e.significance };
  });

  // ── Base-rate header lines. ──
  const [durBr, formBr] = await Promise.all([
    prisma.institutionalBaseRate.findFirst({ where: { pattern: "DURABLE", horizon: "2Q" } }),
    prisma.institutionalBaseRate.findFirst({ where: { pattern: "FORMING", horizon: "2Q" } }),
  ]);

  return {
    filingPeriod: p,
    census,
    transitionsCount: transEvents.length,
    durable,
    forming,
    watch,
    spikes,
    transitions,
    baseRates: { durable: baseRateLine(durBr, "durable builds"), forming: baseRateLine(formBr, "forming builds") },
  };
}

/** Indexed (=100 at window start) split-adjusted close per ticker over `window` periods. */
async function indexedPriceByTicker(tickers: string[], window: string[]): Promise<Map<string, Array<number | null>>> {
  const out = new Map<string, Array<number | null>>();
  if (tickers.length === 0 || window.length === 0) return out;
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  if (secs.length === 0) return out;
  const tickerBySec = new Map(secs.map((s) => [s.id, s.ticker]));
  const start = new Date(`${window[0]}T00:00:00.000Z`);
  const rows = await prisma.priceHistory.findMany({
    where: { securityId: { in: secs.map((s) => s.id) }, tradeDate: { gte: start } },
    select: { securityId: true, tradeDate: true, adjClose: true },
    orderBy: { tradeDate: "asc" },
  });
  const bySec = new Map<string, Array<{ t: number; px: number }>>();
  for (const r of rows) {
    const px = Number(r.adjClose);
    if (!Number.isFinite(px) || px <= 0) continue;
    (bySec.get(r.securityId) ?? bySec.set(r.securityId, []).get(r.securityId)!).push({ t: r.tradeDate.getTime(), px });
  }
  for (const [secId, series] of bySec) {
    const ticker = tickerBySec.get(secId)!;
    // price at each period-end = first close on/after that date.
    const raw = window.map((w) => {
      const asOf = new Date(`${w}T00:00:00.000Z`).getTime();
      let lo = 0;
      let hi = series.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid]!.t < asOf) lo = mid + 1;
        else hi = mid;
      }
      return series[lo]?.px ?? null;
    });
    const base = raw.find((x) => x != null) ?? null;
    out.set(ticker, raw.map((x) => (x != null && base != null && base > 0 ? Math.round((x / base) * 1000) / 10 : null)));
  }
  return out;
}

/**
 * True "% since period-end": split-adjusted return from the close at/after the as-of
 * period-end to the LATEST available close (typically ~1 quarter later). Both legs are
 * adjClose so a split inside the window is already adjusted — no +900% artifact. This
 * is distinct from the full 12q window return (the earlier bug conflated the two).
 */
async function priceSinceByTicker(tickers: string[], periodEndIso: string): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (tickers.length === 0) return out;
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  if (secs.length === 0) return out;
  const tickerBySec = new Map(secs.map((s) => [s.id, s.ticker]));
  const start = new Date(`${periodEndIso}T00:00:00.000Z`);
  const rows = await prisma.priceHistory.findMany({
    where: { securityId: { in: secs.map((s) => s.id) }, tradeDate: { gte: start } },
    select: { securityId: true, tradeDate: true, adjClose: true },
    orderBy: { tradeDate: "asc" },
  });
  const bySec = new Map<string, { first: number | null; last: number | null }>();
  for (const r of rows) {
    const px = Number(r.adjClose);
    if (!Number.isFinite(px) || px <= 0) continue;
    const cur = bySec.get(r.securityId) ?? { first: null, last: null };
    if (cur.first == null) cur.first = px; // first close on/after period-end
    cur.last = px; // latest close (rows are ascending)
    bySec.set(r.securityId, cur);
  }
  for (const [secId, { first, last }] of bySec) {
    const ticker = tickerBySec.get(secId)!;
    out.set(ticker, first != null && last != null && first > 0 ? Math.round((last / first - 1) * 1000) / 10 : null);
  }
  return out;
}

/** Top qualified initiator (by initiationStrength) per ticker this quarter. */
async function topInitiatorByTicker(tickers: string[], period: string): Promise<Map<string, { fund: string; sizingMult: number; isElite: boolean }>> {
  const out = new Map<string, { fund: string; sizingMult: number; isElite: boolean }>();
  if (tickers.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ ticker: string; strength: number; name: string; elite: boolean }>>(Prisma.sql`
    SELECT h.ticker, h."initiationStrength" AS strength, f.name AS name, f."isMostRespected" AS elite
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId"
    WHERE h."filingPeriod" = ${period}::date AND h.ticker IN (${Prisma.join(tickers)}) AND h."initiationStrength" IS NOT NULL
    ORDER BY h."initiationStrength" DESC`);
  for (const r of rows) if (!out.has(r.ticker)) out.set(r.ticker, { fund: r.name, sizingMult: Math.round(r.strength * 100) / 100, isElite: r.elite });
  return out;
}

/** Count of elite (isMostRespected) funds that added/initiated a ticker this quarter. */
async function eliteAdderCountByTicker(tickers: string[], period: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tickers.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ ticker: string; c: bigint }>>(Prisma.sql`
    SELECT h.ticker, count(*) AS c
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isMostRespected" = true
    WHERE h."filingPeriod" = ${period}::date AND h.ticker IN (${Prisma.join(tickers)}) AND h.action IN ('NEW','ADDED')
    GROUP BY h.ticker`);
  for (const r of rows) out.set(r.ticker, Number(r.c));
  return out;
}

/** Auto-generated evidence chips for a durable card. */
function evidenceChips(input: { priceOverStreak: number | null; top: { fund: string; sizingMult: number; isElite: boolean } | null; eliteCount: number; deltaHolders: number; crowded: boolean }): string[] {
  const chips: string[] = [];
  if (input.priceOverStreak != null) {
    if (input.priceOverStreak <= -8) chips.push(`adding into ${input.priceOverStreak.toFixed(0)}% drawdown`);
    else if (Math.abs(input.priceOverStreak) < 8) chips.push("built through flat tape");
    else chips.push(`built through +${input.priceOverStreak.toFixed(0)}% rally`);
  }
  if (input.top) chips.push(`${input.top.fund} @ ${input.top.sizingMult}× sizing`);
  if (input.eliteCount > 0) chips.push(`${input.eliteCount} elite ★`);
  if (input.deltaHolders > 0) chips.push(`+${input.deltaHolders} holders`);
  if (input.crowded) chips.push("crowded (p75 breadth)");
  return chips.slice(0, 4);
}

// ── single-name trajectory (drill-down chart) ───────────────────────────────
export interface SingleTrajectoryPayload {
  ticker: string;
  companyName: string | null;
  points: Array<{
    period: string;
    holders: number;
    breadth: number;
    conviction: number | null;
    deltaHolders: number;
    trajectoryLabel: string | null;
  }>;
}
export async function getTrajectory(ticker: string): Promise<SingleTrajectoryPayload> {
  const t = ticker.toUpperCase();
  const rows = await prisma.institutionalNameAggregate.findMany({
    where: { ticker: t },
    orderBy: { filingPeriod: "asc" },
  });
  return {
    ticker: t,
    companyName: rows[rows.length - 1]?.companyName ?? null,
    points: rows.map((r) => ({
      period: iso(r.filingPeriod),
      holders: r.fundsHolding,
      breadth: Number(r.pctOfFunds.toFixed(2)),
      conviction: r.medianPctOfBook !== null ? Number(r.medianPctOfBook.toFixed(3)) : null,
      deltaHolders: r.deltaHolders,
      trajectoryLabel: r.trajectoryLabel,
    })),
  };
}

// ── Core Holdings board (Part 3/6) ──────────────────────────────────────────
export interface CoreHoldingRow {
  rank: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  endorsementScore: number;
  longHoldVoters: number;
  distinctCategories: number;
  eliteVoters: number;
  medianTenure: number | null;
  avgTenure: number | null;
  censoredPct: number;
  verifyData: boolean;
  /** 12-quarter weight-stability strip (median % of book + holders), ascending. */
  weightStrip: Array<{ period: string; medianPct: number | null; holders: number }>;
  /** Active NAME-level stasis-break this quarter (bell + red final bar), else null.
   *  A break = this quarter's long-hold departure intensity being anomalous vs the
   *  name's own trailing baseline — not one holder among many trimming. */
  stasisBreak: StasisBreakInfo | null;
  /** Endorsement decomposition for the tooltip (fund names resolved). */
  contributions: Array<{ fund: string; contribution: number; tenureMult: number; weightBps: number; isElite: boolean }>;
  /** Data-quality flags from the shared registry (same glyphs as leaderboard/rotation). */
  flags?: FlowFlagId[];
}
export interface StasisBreakInfo {
  significance: number;
  /** z-score of this quarter's long-hold departure intensity vs the name's baseline. */
  severity: number | null;
  /** Fraction of the name's long-hold base that departed this quarter (0-1). */
  intensity: number | null;
  /** Known long-hold base entering the quarter, and how many departed. */
  priorLongHolders: number;
  departed: number;
  /** Some long-hold voters' funds had not filed — the read is partial. */
  partialData: boolean;
  /** Deepest departing tenure — drill flavor, not the headline. */
  rawQuarters: number;
  departing: Array<{ fund: string; tenure: number; tenureMult: number; action: string }>;
}
export interface CoreHoldingsPayload {
  filingPeriod: string;
  rows: CoreHoldingRow[];
  /** Active stasis-break alerts this quarter (alert strip above the board). */
  alerts: Array<{ ticker: string; companyName: string | null } & StasisBreakInfo>;
  /** Base-rate line for the stasis-break pattern (Part 4), null until N≥30. */
  stasisBaseRate: string | null;
}

const CORE_STRIP_QUARTERS = 12;

interface StasisPayload {
  severity?: number | null;
  intensity?: number | null;
  priorLongHolders?: number;
  departed?: number;
  partialData?: boolean;
  rawQuarters?: number;
  departing?: Array<{ fundId: string; tenure: number; tenureMult: number; action: string }>;
}

function toStasisInfo(significance: number, p: StasisPayload | null, fundName: Map<string, string>): StasisBreakInfo {
  return {
    significance,
    severity: p?.severity ?? null,
    intensity: p?.intensity ?? null,
    priorLongHolders: p?.priorLongHolders ?? 0,
    departed: p?.departed ?? 0,
    partialData: p?.partialData ?? false,
    rawQuarters: p?.rawQuarters ?? 0,
    departing: (p?.departing ?? []).map((d) => ({ fund: fundName.get(d.fundId) ?? d.fundId, tenure: d.tenure, tenureMult: d.tenureMult, action: d.action })),
  };
}

export async function getCoreHoldings(period?: string, limit = 25): Promise<CoreHoldingsPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = await listPeriods(); // desc
  const periodDate = new Date(`${p}T00:00:00.000Z`);

  const top = await prisma.institutionalCoreHolding.findMany({
    where: { filingPeriod: periodDate, valid: true },
    orderBy: { endorsementScore: "desc" },
    take: limit,
  });

  // Name-level stasis-break events this quarter. The precompute already fires only
  // when the departure intensity is anomalous vs the name's own baseline, so every
  // stored event is real; significance ≥ 0.75 (= at/above the severity threshold by
  // construction) is a defensive floor.
  const stasis = (await prisma.institutionalEvent.findMany({ where: { kind: "stasis_break", filingPeriod: periodDate } })).filter((e) => e.significance >= 0.75);
  const stasisByTicker = new Map(stasis.map((e) => [e.ticker, e]));

  // Shared data-quality flags (Part 1c) — same registry as leaderboard/rotation/trajectories.
  const flagMap = (await getLeaderboard(p))?.flagsByTicker ?? {};
  const splitHolds = await unresolvedSplitTickers(periodDate);

  // 12-quarter weight-stability strip for the board tickers.
  const pIdx = Math.max(0, periods.indexOf(p));
  const stripPeriods = periods.slice(pIdx, pIdx + CORE_STRIP_QUARTERS).reverse(); // oldest→newest
  const stripDates = stripPeriods.map((w) => new Date(`${w}T00:00:00.000Z`));
  const tickers = top.map((r) => r.ticker);
  const stripRows = tickers.length
    ? await prisma.institutionalNameAggregate.findMany({
        where: { ticker: { in: tickers }, filingPeriod: { in: stripDates } },
        select: { ticker: true, filingPeriod: true, medianPctOfBook: true, fundsHolding: true },
      })
    : [];
  const stripByTicker = new Map<string, Map<string, { medianPct: number | null; holders: number }>>();
  for (const s of stripRows) {
    if (!stripByTicker.has(s.ticker)) stripByTicker.set(s.ticker, new Map());
    stripByTicker.get(s.ticker)!.set(iso(s.filingPeriod), { medianPct: s.medianPctOfBook, holders: s.fundsHolding });
  }

  // Resolve fund names referenced in contributions / stasis payloads.
  const fundIds = new Set<string>();
  for (const r of top) for (const c of ((r.payload as { contributions?: Array<{ fundId: string }> } | null)?.contributions ?? [])) fundIds.add(c.fundId);
  for (const e of stasis) for (const d of ((e.payload as { departing?: Array<{ fundId: string }> } | null)?.departing ?? [])) fundIds.add(d.fundId);
  const fundRows = fundIds.size ? await prisma.institutionalFund.findMany({ where: { id: { in: [...fundIds] } }, select: { id: true, name: true } }) : [];
  const fundName = new Map(fundRows.map((f) => [f.id, f.name]));

  const rows: CoreHoldingRow[] = top.map((r, i) => {
    const contribs = ((r.payload as { contributions?: Array<{ fundId: string; contribution: number; tenureMult: number; weightBps: number; isElite: boolean }> } | null)?.contributions ?? []).map((c) => ({
      fund: fundName.get(c.fundId) ?? c.fundId,
      contribution: c.contribution,
      tenureMult: c.tenureMult,
      weightBps: c.weightBps,
      isElite: c.isElite,
    }));
    const ev = stasisByTicker.get(r.ticker);
    const evP = ev?.payload as StasisPayload | null;
    return {
      rank: i + 1,
      ticker: r.ticker,
      companyName: r.companyName,
      sector: r.sector,
      endorsementScore: r.endorsementScore,
      longHoldVoters: r.longHoldVoters,
      distinctCategories: r.distinctCategories,
      eliteVoters: r.eliteVoters,
      medianTenure: r.medianTenure,
      avgTenure: r.avgTenure,
      censoredPct: r.censoredPct,
      verifyData: r.verifyData,
      weightStrip: stripPeriods.map((w) => ({ period: w, medianPct: stripByTicker.get(r.ticker)?.get(w)?.medianPct ?? null, holders: stripByTicker.get(r.ticker)?.get(w)?.holders ?? 0 })),
      stasisBreak: ev ? toStasisInfo(ev.significance, evP, fundName) : null,
      contributions: contribs.sort((a, b) => b.contribution - a.contribution),
      flags: ((): FlowFlagId[] | undefined => {
        const ids = activeFlowFlags({
          ...flagMap[r.ticker],
          verifyData: r.verifyData || flagMap[r.ticker]?.verifyData,
          tenureVerify: r.censoredPct > 0,
          partialData: evP?.partialData ?? flagMap[r.ticker]?.partialData,
          unresolvedSplit: splitHolds.has(r.ticker),
        }).map((d) => d.id);
        return ids.length ? ids : undefined;
      })(),
    };
  });

  const alerts = stasis
    .sort((a, b) => b.significance - a.significance)
    .slice(0, 15)
    .map((e) => ({
      ticker: e.ticker,
      companyName: top.find((t) => t.ticker === e.ticker)?.companyName ?? null,
      ...toStasisInfo(e.significance, e.payload as StasisPayload | null, fundName),
    }));

  // Stasis-break base-rate line (Part 4).
  const br = await prisma.institutionalBaseRate.findFirst({ where: { pattern: "stasis_break", horizon: "2Q" } });
  const stasisBaseRate =
    br && br.n >= 30 && br.excessReturn != null
      ? `after a stasis break: ${br.excessReturn >= 0 ? "+" : ""}${(br.excessReturn * 100).toFixed(1)}% excess next 2Q (n=${br.n}${br.hitRate != null ? `, ${Math.round(br.hitRate * 100)}% hit` : ""})`
      : br
        ? `stasis-break base rate: insufficient history (n=${br.n})`
        : null;

  return { filingPeriod: p, rows, alerts, stasisBaseRate };
}

// ── 5.4 sector / subsector / stock rotation ─────────────────────────────────
export type RotationGroupBy = "sector" | "subsector" | "stock";
export type RotationSizeFilter = "all" | "ex-mega" | "mega-only";
const SUBSECTOR_LIMIT = 15; // top/bottom N subsectors by net diffusion

export interface RotationGroup {
  groupKey: string; // sector name, subsector name, or ticker
  // Legacy holder-count flow (kept for the tooltip + pre-active-flow fallback).
  netFundsAdding: number;
  fundsAdding: number;
  fundsTrimming: number;
  nameCount: number; // stock view: fundsHolding (holder count)
  companyName?: string | null; // stock view only
  sector?: string | null; // stock view only
  marketCapTier?: string | null; // stock view only
  // Price-adjusted active-rotation metric (null before the first prior quarter).
  netDiffusionPct: number | null; // (in−out)/participating × 100 (raw)
  shrunkDiffusionPct?: number | null; // bar length: (in−out)/(n+k) × 100 (demeaned when on)
  rawDiffusionPct?: number | null; // Part 1a: pre-demean shrunk diffusion (tooltip)
  demeaned?: boolean; // Part 1a: true when shrunkDiffusionPct is relative to the cross-bucket mean
  rankScore?: number | null; // stock view ordering score (raw composite)
  score?: number | null; // Part 3: 0–100 board-rescaled, VISIBLE sort key (stock + subsector)
  belowThreshold?: boolean; // stock view: below the participation floor (search-only)
  flags?: FlowFlagId[]; // Part 5: data-quality flags from the shared registry (same as leaderboard)
  isUnclassified?: boolean; // Part 2: data-quality meter row, rendered last & dimmed
  belowFloor?: boolean; // Part 4: the synthetic "below participation floor" collapse row
  collapsedCount?: number; // Part 4: how many subsectors the collapse row hides
  children?: RotationGroup[]; // Part 4: the collapsed below-floor subsectors (expand to view)
  activeBpsAvg: number | null; // avg deliberate move in bps of book
  dollarNetFlow: number | null; // $ net capital moved (annotation)
  fundsIn: number | null;
  fundsOut: number | null;
  fundsParticipating: number | null;
  // Decision-grade context (Part 5): last quarter's diffusion (ghost tick), the
  // trailing 4-quarter history (tooltip), and the trailing-12q |diffusion|
  // percentile of this quarter's move.
  priorDiffusionPct?: number | null;
  diffusionHistory?: number[];
  percentile?: number | null;
}
export interface RotationPayload {
  filingPeriod: string;
  groupBy: RotationGroupBy;
  hasActiveFlow: boolean; // false only when the period has no prior quarter → UI falls back
  groups: RotationGroup[];
  // Stock view only: the full non-vehicle universe for the search box, and the
  // count of names meeting the participation floor.
  searchable?: RotationGroup[];
  qualifyingCount?: number;
  sizeFilter?: RotationSizeFilter;
  // Part 4 — drill-down header flag when a single name dominates the bucket's |$|.
  concentration?: { ticker: string; pct: number } | null;
}

type StoredActiveFlow = {
  activeBpsAvg: number;
  netDiffusionPct: number;
  fundsIn: number;
  fundsOut: number;
  fundsParticipating: number;
  fundsEvaluated: number;
};

/** Tickers on an UNRESOLVED_SPLIT data hold this quarter (split-detect couldn't
 *  resolve a share-count jump) — Part 5 quarantine flag, same source as elsewhere. */
async function unresolvedSplitTickers(periodDate: Date): Promise<Set<string>> {
  const rows = await prisma.dataQualityEvent.findMany({ where: { kind: "unresolved_split", period: periodDate }, select: { ticker: true } });
  return new Set(rows.map((r) => r.ticker).filter((t): t is string => t != null));
}

/** (in−out)/participating × 100, signed −100..+100; null if no participants. */
function diffusionOf(inN: number | null, outN: number | null, part: number | null): number | null {
  if (part === null || part <= 0) return null;
  return Math.round((((inN ?? 0) - (outN ?? 0)) / part) * 10000) / 100;
}

/** Map a normalized stock-rotation row (+ optional ranked fields) to a RotationGroup. */
function stockGroup(
  r: StockRotationInput,
  ranked: RankedStockRow | null,
  belowThreshold?: boolean,
): RotationGroup {
  return {
    groupKey: r.ticker,
    netFundsAdding: r.fundsBought - r.fundsSold,
    fundsAdding: r.fundsBought,
    fundsTrimming: r.fundsSold,
    nameCount: r.fundsHolding,
    companyName: r.companyName,
    sector: r.sector,
    marketCapTier: r.marketCapTier,
    netDiffusionPct: diffusionOf(r.fundsIn, r.fundsOut, r.fundsParticipating),
    shrunkDiffusionPct: ranked ? ranked.shrunkDiffusionPct : null,
    rankScore: ranked ? ranked.rankScore : null,
    belowThreshold,
    activeBpsAvg: r.activeBpsAvg,
    dollarNetFlow: r.dollarNetFlow,
    fundsIn: r.fundsIn,
    fundsOut: r.fundsOut,
    fundsParticipating: r.fundsParticipating,
  };
}

/** Normalized name-aggregate select shape used by the stock board + drill-down. */
const STOCK_SELECT = {
  ticker: true, companyName: true, sector: true, marketCapTier: true, fundsBought: true, fundsSold: true, fundsHolding: true,
  activeBpsAvg: true, dollarNetFlow: true, fundsRotatedIn: true, fundsRotatedOut: true, fundsParticipating: true,
} as const;
type StockRow = {
  ticker: string; companyName: string | null; sector: string | null; marketCapTier: string | null;
  fundsBought: number; fundsSold: number; fundsHolding: number; activeBpsAvg: number | null;
  dollarNetFlow: unknown; fundsRotatedIn: number | null; fundsRotatedOut: number | null; fundsParticipating: number | null;
};
function toStockInput(r: StockRow): StockRotationInput {
  return {
    ticker: r.ticker, companyName: r.companyName, sector: r.sector, marketCapTier: r.marketCapTier,
    fundsIn: r.fundsRotatedIn, fundsOut: r.fundsRotatedOut, fundsParticipating: r.fundsParticipating,
    activeBpsAvg: r.activeBpsAvg, dollarNetFlow: r.dollarNetFlow !== null ? Number(r.dollarNetFlow) : null,
    fundsBought: r.fundsBought, fundsSold: r.fundsSold, fundsHolding: r.fundsHolding,
  };
}

export async function getRotation(
  period?: string,
  groupBy: RotationGroupBy = "sector",
  sizeFilter: RotationSizeFilter = "all",
  within?: string,
): Promise<RotationPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const cfg = FLOW_LEADERBOARD_CONFIG;

  // Drill-down: names inside one sector/subsector — top-5 accumulation + bottom-5
  // distribution, so the rotation view resolves to names, not a dead-end aggregate.
  if (within && groupBy !== "stock") {
    const rows = (await prisma.institutionalNameAggregate.findMany({
      where: {
        filingPeriod: periodDate,
        NOT: { securityClass: "vehicle" },
        ...(groupBy === "subsector" ? { subsector: within } : { sector: within }),
      },
      select: STOCK_SELECT,
    })) as StockRow[];
    const inputs = rows.map(toStockInput);
    // Part 4 — concentration flag: does one name carry most of the bucket's |$|?
    const concentration = dominantConcentration(inputs, cfg.drilldown_concentration_flag);
    // Part 4 — names with < 3 participating funds are shown dimmed with explicit
    // vote counts (not a diffusion %) and never set the board's sort position: rank
    // only the ≥3-fund names, then append a few low-n names by |$|.
    const DRILL_MIN_N = 3;
    const ranked = rankStockRotation(
      inputs.filter((r) => (r.fundsParticipating ?? 0) >= DRILL_MIN_N),
      { minParticipants: DRILL_MIN_N, k: cfg.diffusion_shrink_k, boardSize: 5, sizeFilter: "all" },
    );
    const lowN = inputs
      .filter((r) => (r.fundsParticipating ?? 0) > 0 && (r.fundsParticipating ?? 0) < DRILL_MIN_N)
      .sort((a, b) => Math.abs(b.dollarNetFlow ?? 0) - Math.abs(a.dollarNetFlow ?? 0))
      .slice(0, 5)
      .map((r) => stockGroup(r, null, true)); // belowThreshold ⇒ UI renders vote counts
    const drillFlags = (await getLeaderboard(p))?.flagsByTicker ?? {};
    const drillSplits = await unresolvedSplitTickers(periodDate);
    const withDrillFlags = (g: RotationGroup): RotationGroup => {
      const ids = activeFlowFlags({ ...drillFlags[g.groupKey], unresolvedSplit: drillSplits.has(g.groupKey) }).map((d) => d.id);
      if (ids.length) g.flags = ids;
      return g;
    };
    const groups = [
      ...ranked.accumulation.map((r) => withDrillFlags(stockGroup(r, r))),
      ...ranked.distribution.map((r) => withDrillFlags(stockGroup(r, r))),
      ...lowN.map(withDrillFlags),
    ];
    return { filingPeriod: p, groupBy, hasActiveFlow: rows.some((r) => r.activeBpsAvg !== null), groups, concentration };
  }

  if (groupBy === "stock") {
    // Per-ticker flow lives on the name aggregates (no sector precompute needed).
    const rows = (await prisma.institutionalNameAggregate.findMany({
      // Vehicles (index/sector/thematic/levered ETFs) are instruments, not names
      // funds rotate between — excluded from the rotation entirely.
      where: { filingPeriod: periodDate, NOT: { securityClass: "vehicle" } },
      select: STOCK_SELECT,
    })) as StockRow[];
    const hasActiveFlow = rows.some((r) => r.activeBpsAvg !== null);
    const inputs = rows.map(toStockInput);

    if (!hasActiveFlow) {
      // Earliest quarter: no prior to price-diff → legacy holder-count fallback.
      const groups = inputs
        .map((r) => stockGroup(r, null))
        .filter((g) => g.netFundsAdding !== 0)
        .sort((a, b) => b.netFundsAdding - a.netFundsAdding)
        .slice(0, cfg.board_size.accumulation);
      return { filingPeriod: p, groupBy, hasActiveFlow, groups, sizeFilter };
    }

    // Shrunk-diffusion, rank-scored top/bottom boards (no full-universe listing).
    const ranked = rankStockRotation(inputs, {
      minParticipants: cfg.min_participants_stock,
      k: cfg.diffusion_shrink_k,
      boardSize: 15,
      sizeFilter,
    });
    const boardRows = [...ranked.accumulation, ...ranked.distribution];
    // Part 3 — 0–100 board-rescaled VISIBLE score (the composite rank score, made
    // legible). One scale across both sub-boards; the most extreme row reads 100.
    const rescaled = rescaleScore0to100(boardRows.map((r) => r.rankScore));
    // Part 5 — shared data-quality flags (same source & glyphs as the leaderboard):
    // verify-weights / partial-data from the leaderboard core, unresolved-split from
    // the split-detect data holds. A quarantined name badges here, no longer silent.
    const flagMap = (await getLeaderboard(p))?.flagsByTicker ?? {};
    const splitHolds = await unresolvedSplitTickers(periodDate);
    const withFlags = (g: RotationGroup): RotationGroup => {
      const ids = activeFlowFlags({ ...flagMap[g.groupKey], unresolvedSplit: splitHolds.has(g.groupKey) }).map((d) => d.id);
      if (ids.length) g.flags = ids;
      return g;
    };
    const groups = boardRows.map((r, i) => {
      const g = stockGroup(r, r);
      g.score = rescaled[i]!;
      return withFlags(g);
    });
    await attachStockHistory(groups, periodDate, p, cfg.diffusion_shrink_k);
    const searchable = ranked.searchable.map((r) => withFlags(stockGroup(r, r, (r.fundsParticipating ?? 0) < cfg.min_participants_stock)));
    return { filingPeriod: p, groupBy, hasActiveFlow, groups, searchable, qualifyingCount: ranked.qualifying, sizeFilter };
  }

  const rows = await prisma.institutionalSectorAggregate.findMany({
    where: { filingPeriod: periodDate, groupType: groupBy === "subsector" ? "SUBSECTOR" : "SECTOR" },
  });
  const mapped: RotationGroup[] = rows.map((r) => {
    const af = (r.aggregatesJson as unknown as { activeFlow?: StoredActiveFlow } | null)?.activeFlow ?? null;
    return {
      groupKey: r.groupKey,
      netFundsAdding: r.netFundsAdding,
      fundsAdding: r.fundsAdding,
      fundsTrimming: r.fundsTrimming,
      nameCount: r.nameCount,
      netDiffusionPct: af?.netDiffusionPct ?? null,
      shrunkDiffusionPct: af
        ? shrunkDiffusionPct(af.fundsIn, af.fundsOut, af.fundsParticipating, FLOW_LEADERBOARD_CONFIG.diffusion_shrink_k)
        : null,
      activeBpsAvg: af?.activeBpsAvg ?? null,
      dollarNetFlow: r.netValueFlow !== null ? Number(r.netValueFlow) : null,
      fundsIn: af?.fundsIn ?? null,
      fundsOut: af?.fundsOut ?? null,
      fundsParticipating: af?.fundsParticipating ?? null,
    };
  });
  const hasActiveFlow = mapped.some((m) => m.netDiffusionPct !== null);
  // Part 2 — "Unclassified" is a data-quality meter, not a sector: pulled out of the
  // ranking, the demeaning baseline, and percentile history; rendered last & dimmed.
  const unclassified = mapped.filter((m) => m.groupKey === UNCLASSIFIED_SECTOR);
  for (const u of unclassified) u.isUnclassified = true;
  let ranked = mapped.filter((m) => m.groupKey !== UNCLASSIFIED_SECTOR);

  // Part 1a — report each bucket's diffusion relative to the cross-bucket,
  // participation-weighted mean this quarter (rotation is inherently relative — the
  // read is "vs the average bucket"). Raw value kept for the tooltip; the
  // participation-weighted Σ of the deviations is 0 by construction.
  if (hasActiveFlow && cfg.demeaned_diffusion) {
    const mean = participationWeightedMean(
      ranked.filter((m) => m.shrunkDiffusionPct != null).map((m) => ({ value: m.shrunkDiffusionPct as number, weight: m.fundsParticipating ?? 0 })),
    );
    for (const m of ranked) {
      if (m.shrunkDiffusionPct == null) continue;
      m.rawDiffusionPct = m.shrunkDiffusionPct;
      m.shrunkDiffusionPct = Math.round((m.shrunkDiffusionPct - mean) * 100) / 100;
      m.demeaned = true;
    }
  }

  // Displayed diffusion (drives the bar + the sort): shrunk (demeaned when on),
  // falling back to raw netDiffusion, then the legacy holder count pre-active-flow.
  const displayed = (m: RotationGroup): number => (hasActiveFlow ? m.shrunkDiffusionPct ?? m.netDiffusionPct ?? 0 : m.netFundsAdding);

  // Part 4 — subsector participation floor: below-floor subsectors collapse into one
  // dimmed, expandable row rather than competing on tiny-n noise.
  let belowFloorRow: RotationGroup | null = null;
  if (groupBy === "subsector" && hasActiveFlow) {
    const below = ranked.filter((m) => (m.fundsParticipating ?? 0) < cfg.min_participants_subsector);
    ranked = ranked.filter((m) => (m.fundsParticipating ?? 0) >= cfg.min_participants_subsector);
    if (below.length > 0) {
      belowFloorRow = {
        groupKey: `below participation floor (${below.length} subsectors)`,
        netFundsAdding: 0, fundsAdding: 0, fundsTrimming: 0, nameCount: below.length,
        netDiffusionPct: null, shrunkDiffusionPct: null, activeBpsAvg: null,
        dollarNetFlow: below.reduce((s, m) => s + (m.dollarNetFlow ?? 0), 0),
        fundsIn: null, fundsOut: null, fundsParticipating: null,
        belowFloor: true, collapsedCount: below.length,
        children: below.slice().sort((a, b) => displayed(b) - displayed(a)),
      };
    }
  }

  // Part 3 — sort by the DISPLAYED diffusion (unrounded, so two rows that round to
  // the same label order correctly), tiebreak on |net $|.
  const sorted = hasActiveFlow
    ? ranked.slice().sort((a, b) => displayed(b) - displayed(a) || Math.abs(b.dollarNetFlow ?? 0) - Math.abs(a.dollarNetFlow ?? 0))
    : ranked.slice().sort((a, b) => b.netFundsAdding - a.netFundsAdding);
  const trimmed = groupBy === "subsector" && sorted.length > SUBSECTOR_LIMIT * 2 ? [...sorted.slice(0, SUBSECTOR_LIMIT), ...sorted.slice(-SUBSECTOR_LIMIT)] : sorted;

  // Part 3 — 0–100 board-rescaled VISIBLE score for the subsector view (composite
  // rank score = displayed diffusion · ln(1+n) · √|bps|; stock scores set below).
  if (groupBy === "subsector") {
    const scores = trimmed.map((m) => stockRankScore(displayed(m), m.fundsParticipating ?? 0, m.activeBpsAvg ?? 0));
    const rescaled = rescaleScore0to100(scores);
    trimmed.forEach((m, i) => {
      m.rankScore = scores[i]!;
      m.score = rescaled[i]!;
    });
  }

  const groups = [...trimmed, ...(belowFloorRow ? [belowFloorRow] : []), ...unclassified];
  await attachSectorHistory(groups, groupBy === "subsector" ? "SUBSECTOR" : "SECTOR", periodDate, p, cfg.diffusion_shrink_k, cfg.demeaned_diffusion);
  return { filingPeriod: p, groupBy, hasActiveFlow, groups };
}

/** Attach ghost/history/percentile to sector or subsector rows from their own
 *  trailing-12-quarter shrunk-diffusion series. */
async function attachSectorHistory(
  groups: RotationGroup[],
  groupType: "SECTOR" | "SUBSECTOR",
  periodDate: Date,
  currentIso: string,
  k: number,
  demean: boolean,
): Promise<void> {
  if (groups.length === 0) return;
  const periods = await prisma.institutionalSectorAggregate.findMany({
    where: { groupType, filingPeriod: { lte: periodDate } },
    distinct: ["filingPeriod"],
    select: { filingPeriod: true },
    orderBy: { filingPeriod: "desc" },
    take: 12,
  });
  const rows = await prisma.institutionalSectorAggregate.findMany({
    where: { groupType, filingPeriod: { in: periods.map((r) => r.filingPeriod) } },
    select: { groupKey: true, filingPeriod: true, aggregatesJson: true },
  });
  type Pt = { groupKey: string; period: string; value: number; weight: number };
  const pts: Pt[] = [];
  for (const r of rows) {
    const af = (r.aggregatesJson as unknown as { activeFlow?: StoredActiveFlow } | null)?.activeFlow;
    if (!af) continue;
    pts.push({ groupKey: r.groupKey, period: iso(r.filingPeriod), value: shrunkDiffusionPct(af.fundsIn, af.fundsOut, af.fundsParticipating, k), weight: af.fundsParticipating });
  }
  // Part 1a — demean each historical quarter by its cross-bucket participation-
  // weighted mean (real buckets only), so ghost ticks & percentiles compare the
  // bucket to its own past under the SAME (demeaned) definition it renders with.
  if (demean) {
    const meanByPeriod = new Map<string, number>();
    const byPeriod = new Map<string, Pt[]>();
    for (const pt of pts) if (pt.groupKey !== UNCLASSIFIED_SECTOR) (byPeriod.get(pt.period) ?? byPeriod.set(pt.period, []).get(pt.period)!).push(pt);
    for (const [per, arr] of byPeriod) meanByPeriod.set(per, participationWeightedMean(arr.map((x) => ({ value: x.value, weight: x.weight }))));
    for (const pt of pts) {
      if (pt.groupKey === UNCLASSIFIED_SECTOR) continue;
      pt.value = Math.round((pt.value - (meanByPeriod.get(pt.period) ?? 0)) * 100) / 100;
    }
  }
  const series = new Map<string, Array<{ period: string; value: number }>>();
  for (const pt of pts) (series.get(pt.groupKey) ?? series.set(pt.groupKey, []).get(pt.groupKey)!).push({ period: pt.period, value: pt.value });
  for (const g of groups) {
    // Unclassified (data meter) and the below-floor collapse row are excluded from
    // percentile ranking / ghost ticks.
    if (g.isUnclassified || g.belowFloor) continue;
    const ctx = diffusionContext(series.get(g.groupKey) ?? [], currentIso);
    g.priorDiffusionPct = ctx.prior;
    g.diffusionHistory = ctx.history;
    g.percentile = ctx.percentile;
  }
}

/** Attach ghost/history/percentile to the stock board rows (their own tickers'
 *  trailing-12-quarter shrunk-diffusion series). */
async function attachStockHistory(groups: RotationGroup[], periodDate: Date, currentIso: string, k: number): Promise<void> {
  const tickers = groups.map((g) => g.groupKey);
  if (tickers.length === 0) return;
  const periods = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: { lte: periodDate }, ticker: { in: tickers } },
    distinct: ["filingPeriod"],
    select: { filingPeriod: true },
    orderBy: { filingPeriod: "desc" },
    take: 12,
  });
  const rows = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: { in: periods.map((r) => r.filingPeriod) }, ticker: { in: tickers } },
    select: { ticker: true, filingPeriod: true, fundsRotatedIn: true, fundsRotatedOut: true, fundsParticipating: true },
  });
  const series = new Map<string, Array<{ period: string; value: number }>>();
  for (const r of rows) {
    if (r.fundsParticipating === null) continue;
    const value = shrunkDiffusionPct(r.fundsRotatedIn ?? 0, r.fundsRotatedOut ?? 0, r.fundsParticipating, k);
    (series.get(r.ticker) ?? series.set(r.ticker, []).get(r.ticker)!).push({ period: iso(r.filingPeriod), value });
  }
  for (const g of groups) {
    const ctx = diffusionContext(series.get(g.groupKey) ?? [], currentIso);
    g.priorDiffusionPct = ctx.prior;
    g.diffusionHistory = ctx.history;
    g.percentile = ctx.percentile;
  }
}

// ── 5.5 single-name fund ledger ─────────────────────────────────────────────
export interface LedgerRow {
  fundName: string;
  cik: string;
  category: string;
  isMostRespected: boolean;
  action: string;
  positionM: number; // $M
  pctOfBook: number | null;
  /** Qualified-initiation sizing multiple (Part 1b); null if not a qualified entry. */
  sizingMult: number | null;
}
export interface LedgerPayload {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  filingPeriod: string;
  trackedFunds: number;
  fundsHolding: number;
  fundsAddedOrNew: number;
  fundsTrimmed: number;
  fundsExited: number;
  rows: LedgerRow[];
}
export async function getLedger(ticker: string, period?: string): Promise<LedgerPayload | null> {
  const t = ticker.toUpperCase();
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const [agg, holdings, trackedFunds] = await Promise.all([
    prisma.institutionalNameAggregate.findUnique({ where: { ticker_filingPeriod: { ticker: t, filingPeriod: periodDate } } }),
    prisma.fundHoldingSnapshot.findMany({
      where: { ticker: t, filingPeriod: periodDate },
      include: { fund: { select: { name: true, cik: true, category: true, isMostRespected: true } } },
    }),
    trackedFundsInPeriod(p),
  ]);
  const rows: LedgerRow[] = holdings.map((h) => ({
    fundName: h.fund.name,
    cik: h.fund.cik,
    category: h.fund.category,
    isMostRespected: h.fund.isMostRespected,
    action: h.action,
    positionM: Number((Number(h.value) / 1e6).toFixed(1)),
    pctOfBook: h.pctOfBook !== null ? Number(h.pctOfBook.toFixed(2)) : null,
    sizingMult: h.initiationStrength ?? null,
  }));
  // sort: holders first (by % of book desc), exits last
  rows.sort((a, b) => {
    const ax = a.action === "EXITED" ? -1 : 1;
    const bx = b.action === "EXITED" ? -1 : 1;
    if (ax !== bx) return bx - ax;
    return (b.pctOfBook ?? 0) - (a.pctOfBook ?? 0);
  });
  return {
    ticker: t,
    companyName: agg?.companyName ?? holdings[0]?.nameOfIssuer ?? null,
    sector: agg?.sector ?? null,
    marketCapTier: agg?.marketCapTier ?? null,
    filingPeriod: p,
    trackedFunds,
    fundsHolding: agg?.fundsHolding ?? rows.filter((r) => r.action !== "EXITED").length,
    fundsAddedOrNew: (agg?.fundsNew ?? 0) + (agg?.fundsAdded ?? 0),
    fundsTrimmed: agg?.fundsTrimmed ?? 0,
    fundsExited: agg?.fundsExited ?? 0,
    rows,
  };
}

// ── §6 first-mover / consensus-lag ──────────────────────────────────────────
export interface FirstMoverRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  respectedFirstPeriod: string;
  broadPeriod: string;
  leadQuarters: number;
  currentHolders: number;
  earlyRespectedFunds: string[];
}
export async function getFirstMovers(period?: string, broadThreshold = 6): Promise<{ filingPeriod: string; rows: FirstMoverRow[] } | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = (await listPeriods()).slice().reverse(); // oldest→newest
  const stat = await prisma.$queryRaw<
    Array<{ ticker: string; period: Date; total: bigint; respected: bigint }>
  >(Prisma.sql`
    SELECT h.ticker, h."filingPeriod" AS period,
      count(*) FILTER (WHERE h.shares > 0) AS total,
      count(*) FILTER (WHERE h.shares > 0 AND f."isMostRespected") AS respected
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    GROUP BY h.ticker, h."filingPeriod"`);

  const byTicker = new Map<string, Map<string, { total: number; respected: number }>>();
  for (const s of stat) {
    const per = iso(s.period);
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, new Map());
    byTicker.get(s.ticker)!.set(per, { total: Number(s.total), respected: Number(s.respected) });
  }
  const idxOf = new Map(periods.map((per, i) => [per, i]));
  const out: FirstMoverRow[] = [];
  for (const [ticker, series] of byTicker) {
    let respectedFirst: string | null = null;
    let broad: string | null = null;
    for (const per of periods) {
      const s = series.get(per);
      if (!s) continue;
      if (respectedFirst === null && s.respected >= 1) respectedFirst = per;
      if (broad === null && s.total >= broadThreshold) broad = per;
    }
    if (!respectedFirst || !broad) continue;
    // Left-censoring guard: if a respected fund's first OBSERVED holding is in
    // our earliest period, it may have held earlier — we can't claim it was
    // first, so drop it rather than report an inflated lead.
    if ((idxOf.get(respectedFirst) ?? 0) === 0) continue;
    const lead = (idxOf.get(broad) ?? 0) - (idxOf.get(respectedFirst) ?? 0);
    if (lead < 2) continue; // respected established >= 2 quarters before broad
    const current = series.get(p);
    if (!current || current.total < 2) continue; // still a live name
    out.push({
      ticker,
      companyName: null,
      sector: null,
      marketCapTier: null,
      respectedFirstPeriod: respectedFirst,
      broadPeriod: broad,
      leadQuarters: lead,
      currentHolders: current.total,
      earlyRespectedFunds: [],
    });
  }
  // Enrich the surviving names + which most-respected funds were early.
  const tickers = out.map((o) => o.ticker);
  if (tickers.length) {
    const meta = await prisma.institutionalNameAggregate.findMany({
      where: { ticker: { in: tickers }, filingPeriod: new Date(`${p}T00:00:00.000Z`) },
      select: { ticker: true, companyName: true, sector: true, marketCapTier: true },
    });
    const metaMap = new Map(meta.map((m) => [m.ticker, m]));
    const early = await prisma.fundHoldingSnapshot.findMany({
      where: {
        ticker: { in: tickers },
        shares: { gt: 0 },
        fund: { isMostRespected: true, isActive: true },
        filingPeriod: { in: out.map((o) => new Date(`${o.respectedFirstPeriod}T00:00:00.000Z`)) },
      },
      select: { ticker: true, filingPeriod: true, fund: { select: { name: true } } },
    });
    const earlyMap = new Map<string, Set<string>>();
    for (const e of early) {
      const o = out.find((x) => x.ticker === e.ticker && x.respectedFirstPeriod === iso(e.filingPeriod));
      if (o) {
        if (!earlyMap.has(o.ticker)) earlyMap.set(o.ticker, new Set());
        earlyMap.get(o.ticker)!.add(e.fund.name);
      }
    }
    for (const o of out) {
      const m = metaMap.get(o.ticker);
      o.companyName = m?.companyName ?? null;
      o.sector = m?.sector ?? null;
      o.marketCapTier = m?.marketCapTier ?? null;
      o.earlyRespectedFunds = Array.from(earlyMap.get(o.ticker) ?? []);
    }
  }
  out.sort((a, b) => b.leadQuarters - a.leadQuarters || b.currentHolders - a.currentHolders);
  return { filingPeriod: p, rows: out.slice(0, 40) };
}

// ── §6 exit-cluster alert ────────────────────────────────────────────────────
export interface ExitClusterRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  convictionExits: number; // # high-conviction holders that trimmed/exited
  eliteExits: number; // # of those that were most-respected (elite) funds
  eliteSizing: number; // Σ prior %-of-book of the elite trims (trim sizing)
  totalExits: number;
  funds: Array<{ name: string; action: string; priorPctOfBook: number | null }>;
}
export async function getExitClusters(period?: string, minExits = 3): Promise<{ filingPeriod: string; rows: ExitClusterRow[] } | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = await listPeriods();
  const idx = periods.indexOf(p);
  const priorP = idx >= 0 && idx + 1 < periods.length ? periods[idx + 1]! : null;
  if (!priorP) return { filingPeriod: p, rows: [] };
  const periodDate = new Date(`${p}T00:00:00.000Z`);

  // High-conviction holders (prior quarter) that trimmed/exited this quarter.
  const rows = await prisma.$queryRaw<
    Array<{ ticker: string; fund_name: string; action: string; prior_pct: number | null; is_respected: boolean }>
  >(Prisma.sql`
    SELECT c.ticker, f.name AS fund_name, c.action, pr."pctOfBook" AS prior_pct, f."isMostRespected" AS is_respected
    FROM "FundHoldingSnapshot" c
    JOIN "InstitutionalFund" f ON f.id = c."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    JOIN "FundHoldingSnapshot" pr ON pr."fundId" = c."fundId" AND pr.ticker = c.ticker AND pr."filingPeriod" = ${priorP}::date
    WHERE c."filingPeriod" = ${p}::date
      AND c.action IN ('TRIMMED', 'EXITED')
      AND (pr."pctOfBook" >= ${HIGH_CONVICTION_PCT} OR f."isMostRespected" = true)`);

  const byTicker = new Map<string, ExitClusterRow>();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) {
      byTicker.set(r.ticker, {
        ticker: r.ticker,
        companyName: null,
        sector: null,
        marketCapTier: null,
        convictionExits: 0,
        eliteExits: 0,
        eliteSizing: 0,
        totalExits: 0,
        funds: [],
      });
    }
    const e = byTicker.get(r.ticker)!;
    e.convictionExits += 1;
    if (r.is_respected) {
      e.eliteExits += 1;
      e.eliteSizing += r.prior_pct !== null ? Number(r.prior_pct) : 0;
    }
    e.funds.push({ name: r.fund_name, action: r.action, priorPctOfBook: r.prior_pct !== null ? Number(Number(r.prior_pct).toFixed(2)) : null });
  }
  const out = Array.from(byTicker.values()).filter((e) => e.convictionExits >= minExits);
  const tickers = out.map((o) => o.ticker);
  if (tickers.length) {
    const meta = await prisma.institutionalNameAggregate.findMany({
      where: { ticker: { in: tickers }, filingPeriod: periodDate },
      select: { ticker: true, companyName: true, sector: true, marketCapTier: true, fundsExited: true, fundsTrimmed: true },
    });
    const metaMap = new Map(meta.map((m) => [m.ticker, m]));
    for (const o of out) {
      const m = metaMap.get(o.ticker);
      o.companyName = m?.companyName ?? null;
      o.sector = m?.sector ?? null;
      o.marketCapTier = m?.marketCapTier ?? null;
      o.totalExits = (m?.fundsExited ?? 0) + (m?.fundsTrimmed ?? 0);
      o.funds.sort((a, b) => (b.priorPctOfBook ?? 0) - (a.priorPctOfBook ?? 0));
    }
  }
  out.sort((a, b) => b.convictionExits - a.convictionExits);
  return { filingPeriod: p, rows: out.slice(0, 40) };
}

// ── §6 triangulation hook — Engine 3 crowding as a standalone column ─────────
export interface CrowdingColumn {
  ticker: string;
  breadth: number;
  breadthDecile: number | null;
  conviction: number | null;
  fundsHolding: number;
  deltaHolders: number;
  quadrant: string | null;
}
export async function getCrowdingColumn(tickers: string[], period?: string): Promise<{ filingPeriod: string; byTicker: Record<string, CrowdingColumn> } | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const upper = tickers.map((t) => t.toUpperCase());
  const rows = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: new Date(`${p}T00:00:00.000Z`), ticker: { in: upper } },
  });
  const byTicker: Record<string, CrowdingColumn> = {};
  for (const r of rows) {
    byTicker[r.ticker] = {
      ticker: r.ticker,
      breadth: Number(r.pctOfFunds.toFixed(2)),
      breadthDecile: r.breadthDecile,
      conviction: r.medianPctOfBook !== null ? Number(r.medianPctOfBook.toFixed(3)) : null,
      fundsHolding: r.fundsHolding,
      deltaHolders: r.deltaHolders,
      quadrant: r.quadrant,
    };
  }
  return { filingPeriod: p, byTicker };
}

// ── watchlist CRUD ───────────────────────────────────────────────────────────
export interface FundRow {
  id: string;
  cik: string;
  name: string;
  edgarName: string | null;
  category: string;
  tier: string; // "signal" | "context"
  isMostRespected: boolean;
  isActive: boolean;
  notes: string | null;
  latestHoldings: number | null;
}
export async function listFunds(): Promise<FundRow[]> {
  const funds = await prisma.institutionalFund.findMany({ orderBy: [{ categorySort: "asc" }, { category: "asc" }, { name: "asc" }] });
  // latest holdings count per fund
  const latest = await prisma.institutionalNameAggregate.findFirst({ orderBy: { filingPeriod: "desc" }, select: { filingPeriod: true } });
  const counts = latest
    ? await prisma.fundHoldingSnapshot.groupBy({
        by: ["fundId"],
        where: { filingPeriod: latest.filingPeriod, shares: { gt: 0 } },
        _count: true,
      })
    : [];
  const countMap = new Map(counts.map((c) => [c.fundId, c._count]));
  return funds.map((f) => ({
    id: f.id,
    cik: f.cik,
    name: f.name,
    edgarName: f.edgarName,
    category: f.category,
    tier: f.tier,
    isMostRespected: f.isMostRespected,
    isActive: f.isActive,
    notes: f.notes,
    latestHoldings: countMap.get(f.id) ?? null,
  }));
}

export async function createFund(input: {
  cik: string;
  name: string;
  edgarName?: string;
  category?: FundCategory;
  tier?: "signal" | "context";
  isMostRespected?: boolean;
}): Promise<{ id: string }> {
  const cik = input.cik.replace(/\D/g, "").padStart(10, "0");
  const category = input.category ?? "Growth/Quality";
  const f = await prisma.institutionalFund.create({
    data: {
      cik,
      name: input.name,
      edgarName: input.edgarName ?? null,
      category,
      categorySort: CATEGORY_TIER[category],
      tier: input.tier ?? "signal",
      isMostRespected: input.isMostRespected ?? false,
    },
  });
  return { id: f.id };
}

export async function updateFund(
  id: string,
  patch: Partial<{ name: string; edgarName: string | null; category: FundCategory; tier: "signal" | "context"; isMostRespected: boolean; isActive: boolean; notes: string | null }>,
): Promise<void> {
  const data: Prisma.InstitutionalFundUpdateInput = { ...patch };
  if (patch.category) data.categorySort = CATEGORY_TIER[patch.category]; // categorySort stays a derived sort key
  // Re-tiering is global (recomputes a fund's whole history). Log the change so a
  // metrics recompute (job:institutional --aggregate-only) can be triggered.
  if (patch.tier) {
    const existing = await prisma.institutionalFund.findUnique({ where: { id }, select: { tier: true, cik: true, name: true } });
    if (existing && existing.tier !== patch.tier) {
      await prisma.dataQualityEvent.create({
        data: { kind: "tier_change", fundId: id, payload: { cik: existing.cik, name: existing.name, from: existing.tier, to: patch.tier, actor: "admin" } },
      });
    }
  }
  await prisma.institutionalFund.update({ where: { id }, data });
}

export async function deleteFund(id: string): Promise<void> {
  await prisma.institutionalFund.delete({ where: { id } });
}
