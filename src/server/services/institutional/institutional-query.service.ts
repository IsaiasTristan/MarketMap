/**
 * Engine 3 — read layer for the Flows dashboard views. All functions are
 * point-in-time (keyed by filing period) and return raw counts + the two visible
 * axes (breadth, conviction) — no composite scores. Interfaces here are the API
 * contract; the client type-imports them.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { CROWDED_BREADTH_PCT, notDiversifiedFilter } from "./institutional-aggregate.service";

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
  // Excludes broadly-diversified quant books so the count matches the breadth
  // denominator used to build the aggregates (see notDiversifiedFilter).
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(DISTINCT h."fundId") AS n
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true
    WHERE h."filingPeriod" = ${period}::date AND h.shares > 0 AND ${notDiversifiedFilter("h")}`);
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
  fundsHolding: number;
  fundsBought: number;
  fundsSold: number;
  quadrant: string | null;
  trajectoryLabel: string | null;
}
export interface QuadrantPayload {
  filingPeriod: string;
  breadthLine: number;
  convictionLine: number;
  trackedFunds: number;
  points: QuadrantPoint[];
}

export async function getQuadrant(period?: string, minFunds = 2): Promise<QuadrantPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const [rows, convictionLine, trackedFunds] = await Promise.all([
    prisma.institutionalNameAggregate.findMany({
      where: { filingPeriod: periodDate, fundsHolding: { gte: minFunds } },
      orderBy: { fundsHolding: "desc" },
    }),
    convictionLineForPeriod(periodDate),
    trackedFundsInPeriod(p),
  ]);
  return {
    filingPeriod: p,
    breadthLine: CROWDED_BREADTH_PCT,
    convictionLine,
    trackedFunds,
    points: rows.map((r) => ({
      ticker: r.ticker,
      companyName: r.companyName,
      sector: r.sector,
      marketCapTier: r.marketCapTier,
      breadth: Number(r.pctOfFunds.toFixed(2)),
      conviction: r.medianPctOfBook !== null ? Number(r.medianPctOfBook.toFixed(3)) : null,
      deltaHolders: r.deltaHolders,
      fundsHolding: r.fundsHolding,
      fundsBought: r.fundsBought,
      fundsSold: r.fundsSold,
      quadrant: r.quadrant,
      trajectoryLabel: r.trajectoryLabel,
    })),
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
  trajectoryLabel: string | null;
  series: Array<{ period: string; holders: number }>;
}
export interface TrajectoryGridPayload {
  filingPeriod: string;
  cards: TrajectoryCard[];
}

export async function getTrajectoryGrid(
  period?: string,
  limit = 12,
  sort: "delta" | "holders" = "delta",
): Promise<TrajectoryGridPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const periods = await listPeriods();
  const periodDate = new Date(`${p}T00:00:00.000Z`);
  const top = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: periodDate, fundsBought: { gt: 0 } },
    orderBy:
      sort === "holders"
        ? [{ fundsHolding: "desc" }]
        : [{ deltaHolders: "desc" }, { fundsBought: "desc" }],
    take: limit,
  });
  const tickers = top.map((t) => t.ticker);
  // 8-quarter window ENDING at the selected period (periods is desc), not the
  // globally-latest 8 — otherwise a historical selection plots later quarters.
  const pIdx = Math.max(0, periods.indexOf(p));
  const window = periods.slice(pIdx, pIdx + 8).reverse(); // oldest→newest, ending at p
  const windowDates = window.map((w) => new Date(`${w}T00:00:00.000Z`));
  const series = await prisma.institutionalNameAggregate.findMany({
    where: { ticker: { in: tickers }, filingPeriod: { in: windowDates } },
    select: { ticker: true, filingPeriod: true, fundsHolding: true },
  });
  const byTicker = new Map<string, Map<string, number>>();
  for (const s of series) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, new Map());
    byTicker.get(s.ticker)!.set(iso(s.filingPeriod), s.fundsHolding);
  }
  return {
    filingPeriod: p,
    cards: top.map((t) => ({
      ticker: t.ticker,
      companyName: t.companyName,
      sector: t.sector,
      marketCapTier: t.marketCapTier,
      latestHolders: t.fundsHolding,
      deltaHolders: t.deltaHolders,
      trajectoryLabel: t.trajectoryLabel,
      series: window.map((w) => ({ period: w, holders: byTicker.get(t.ticker)?.get(w) ?? 0 })),
    })),
  };
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

// ── 5.4 sector rotation ─────────────────────────────────────────────────────
export interface RotationPayload {
  filingPeriod: string;
  sectors: Array<{
    sector: string;
    netFundsAdding: number;
    fundsAdding: number;
    fundsTrimming: number;
    nameCount: number;
  }>;
}
export async function getRotation(period?: string): Promise<RotationPayload | null> {
  const p = await resolvePeriod(period);
  if (!p) return null;
  const rows = await prisma.institutionalSectorAggregate.findMany({
    where: { filingPeriod: new Date(`${p}T00:00:00.000Z`), groupType: "SECTOR" },
    orderBy: { netFundsAdding: "desc" },
  });
  return {
    filingPeriod: p,
    sectors: rows.map((r) => ({
      sector: r.groupKey,
      netFundsAdding: r.netFundsAdding,
      fundsAdding: r.fundsAdding,
      fundsTrimming: r.fundsTrimming,
      nameCount: r.nameCount,
    })),
  };
}

// ── 5.5 single-name fund ledger ─────────────────────────────────────────────
export interface LedgerRow {
  fundName: string;
  tier: number;
  isMostRespected: boolean;
  action: string;
  positionM: number; // $M
  pctOfBook: number | null;
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
      include: { fund: { select: { name: true, tier: true, isMostRespected: true } } },
    }),
    trackedFundsInPeriod(p),
  ]);
  const rows: LedgerRow[] = holdings.map((h) => ({
    fundName: h.fund.name,
    tier: h.fund.tier,
    isMostRespected: h.fund.isMostRespected,
    action: h.action,
    positionM: Number((Number(h.value) / 1e6).toFixed(1)),
    pctOfBook: h.pctOfBook !== null ? Number(h.pctOfBook.toFixed(2)) : null,
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
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true
    WHERE ${notDiversifiedFilter("h")}
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
    JOIN "InstitutionalFund" f ON f.id = c."fundId" AND f."isActive" = true
    JOIN "FundHoldingSnapshot" pr ON pr."fundId" = c."fundId" AND pr.ticker = c.ticker AND pr."filingPeriod" = ${priorP}::date
    WHERE c."filingPeriod" = ${p}::date
      AND c.action IN ('TRIMMED', 'EXITED')
      AND (pr."pctOfBook" >= ${HIGH_CONVICTION_PCT} OR f."isMostRespected" = true)
      AND ${notDiversifiedFilter("c")}`);

  const byTicker = new Map<string, ExitClusterRow>();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) {
      byTicker.set(r.ticker, {
        ticker: r.ticker,
        companyName: null,
        sector: null,
        marketCapTier: null,
        convictionExits: 0,
        totalExits: 0,
        funds: [],
      });
    }
    const e = byTicker.get(r.ticker)!;
    e.convictionExits += 1;
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
  tier: number;
  isMostRespected: boolean;
  isActive: boolean;
  notes: string | null;
  latestHoldings: number | null;
}
export async function listFunds(): Promise<FundRow[]> {
  const funds = await prisma.institutionalFund.findMany({ orderBy: [{ tier: "asc" }, { name: "asc" }] });
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
  tier?: number;
  isMostRespected?: boolean;
}): Promise<{ id: string }> {
  const cik = input.cik.replace(/\D/g, "").padStart(10, "0");
  const f = await prisma.institutionalFund.create({
    data: {
      cik,
      name: input.name,
      edgarName: input.edgarName ?? null,
      tier: input.tier ?? 1,
      isMostRespected: input.isMostRespected ?? false,
    },
  });
  return { id: f.id };
}

export async function updateFund(
  id: string,
  patch: Partial<{ name: string; edgarName: string | null; tier: number; isMostRespected: boolean; isActive: boolean; notes: string | null }>,
): Promise<void> {
  await prisma.institutionalFund.update({ where: { id }, data: patch as Prisma.InstitutionalFundUpdateInput });
}

export async function deleteFund(id: string): Promise<void> {
  await prisma.institutionalFund.delete({ where: { id } });
}
