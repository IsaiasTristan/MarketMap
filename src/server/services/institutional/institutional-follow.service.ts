/**
 * Engine 3 — Follow-attribution read layer (FUNDS Part 1).
 *
 * Assembles Initiation events from the precomputed qualified-initiation column
 * (FundHoldingSnapshot.initiationStrength, signal-tier only) + per-period sector,
 * attaches forward 1Q/2Q returns (split-adjusted, availability-dated → no lookahead),
 * and runs the pure computeFollowAttribution core. Builds the Originator Scoreboard.
 *
 * No heavy compute beyond the price join is done here; the attribution itself is a
 * pure function. Price loads are chunked by security (an unbounded findMany
 * overflows the Prisma napi bridge).
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  computeFollowAttribution,
  type Initiation,
  type FollowerVote,
  type InitiationOutcome,
} from "@/domain/calculations/follow-attribution";
import { FUNDS_ATTRIBUTION_CONFIG, type FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";
import { priceAsOf, type PricePoint } from "@/domain/calculations/base-rates";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const DAY = 86_400_000;
const AVAIL_LAG_DAYS = 46; // 13F availability lag (matches base-rates + ingest window)
const HORIZON_1Q = 91;
const HORIZON_2Q = 182;

function availabilityMs(periodEnd: string): number {
  return new Date(`${periodEnd}T00:00:00.000Z`).getTime() + AVAIL_LAG_DAYS * DAY;
}

export interface ScoreboardRow {
  fundId: string;
  cik: string;
  name: string;
  category: string;
  isElite: boolean;
  /** Resolved initiations in the stat window. */
  n: number;
  followed: number;
  followRate: number | null;
  medianLead: number | null;
  fwd2q: number | null;
  hitRate2q: number | null;
  bestSector: string | null;
  bestSectorRate: number | null;
  /** Trailing-4q vs prior-4q follow rate for the trend arrow. */
  trendRecent: number | null;
  trendPrior: number | null;
  rateSufficient: boolean;
  /** Receipt meter: one block per qualified initiation in the stat window,
   *  filled = followed. `n` = total blocks, `f` = filled; pending shown separately. */
  meter: { n: number; f: number; pending: number };
  /** Fresh-now tickers: pending initiations with zero followers so far. */
  freshTickers: string[];
  /** Exit-lead rate + n (Part 2), merged in by the scoreboard route; null when unavailable. */
  exitLeadRate?: number | null;
  exitLeadN?: number;
}

export interface FollowScoreboard {
  filingPeriod: string;
  rows: ScoreboardRow[];
  /** Cohort median follow rate across funds with a sufficient rate (sanity check). */
  cohortMedianRate: number | null;
  outcomesByFund: Map<string, InitiationOutcome[]>;
  /** Ascending global period list (index = quarter). */
  periods: string[];
  /** The assembled qualified initiations (with fwd returns) — reused by the fresh
   *  calls feed's base-rate header and the fund page. */
  initiations: Initiation[];
}

/** Global ascending quarter index for a period string. */
async function periodIndex(): Promise<{ index: Map<string, number>; periods: string[] }> {
  const rows = await prisma.institutionalNameAggregate.findMany({
    distinct: ["filingPeriod"],
    select: { filingPeriod: true },
    orderBy: { filingPeriod: "asc" },
  });
  const periods = rows.map((r) => iso(r.filingPeriod));
  const index = new Map(periods.map((p, i) => [p, i]));
  return { index, periods };
}

/** Load qualified initiations (signal-tier) with per-period sector + filing date. */
async function loadInitiationRows(): Promise<
  Array<{ fundId: string; ticker: string; period: string; strength: number; sector: string | null }>
> {
  const rows = await prisma.$queryRaw<
    Array<{ fundId: string; ticker: string; period: Date; strength: number; sector: string | null }>
  >(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h."filingPeriod" AS period,
           h."initiationStrength" AS strength, na.sector
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    LEFT JOIN "InstitutionalNameAggregate" na ON na.ticker = h.ticker AND na."filingPeriod" = h."filingPeriod"
    WHERE h."initiationStrength" IS NOT NULL AND h.shares > 0`);
  return rows.map((r) => ({ ...r, period: iso(r.period) }));
}

/** Load follow-vote candidates: signal-tier NEW positions ≥ the materiality floor
 *  (bps of book). A superset of the qualified originators — the asymmetric follower
 *  bar (no sizing-multiple gate). */
async function loadFollowerRows(
  floorBps: number,
): Promise<Array<{ fundId: string; ticker: string; period: string; entryBps: number }>> {
  const floorPct = floorBps / 100; // pctOfBook is a percent (2 = 2%); 25bps = 0.25%
  const rows = await prisma.$queryRaw<Array<{ fundId: string; ticker: string; period: Date; pct: number }>>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h."filingPeriod" AS period, h."pctOfBook" AS pct
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    WHERE h.action = 'NEW' AND h.shares > 0 AND h."pctOfBook" >= ${floorPct}`);
  return rows.map((r) => ({ fundId: r.fundId, ticker: r.ticker, period: iso(r.period), entryBps: r.pct * 100 }));
}

/** Forward 1Q/2Q raw returns per (ticker, period) from split-adjusted closes. */
async function forwardReturns(
  tickerPeriods: Array<{ ticker: string; period: string }>,
): Promise<Map<string, { fwd1q: number | null; fwd2q: number | null }>> {
  const out = new Map<string, { fwd1q: number | null; fwd2q: number | null }>();
  const tickers = [...new Set(tickerPeriods.map((t) => t.ticker))];
  const secs = await prisma.security.findMany({ where: { ticker: { in: tickers } }, select: { id: true, ticker: true } });
  const secIdByTicker = new Map(secs.map((s) => [s.ticker, s.id]));
  if (secs.length === 0) return out;
  const minMs = Math.min(...tickerPeriods.map((t) => availabilityMs(t.period)));
  const fromDate = new Date(minMs - 7 * DAY);
  const priceBySec = new Map<string, PricePoint[]>();
  const secIds = secs.map((s) => s.id);
  const CHUNK = 120;
  for (let i = 0; i < secIds.length; i += CHUNK) {
    const batch = secIds.slice(i, i + CHUNK);
    const prices = await prisma.priceHistory.findMany({
      where: { securityId: { in: batch }, tradeDate: { gte: fromDate } },
      select: { securityId: true, tradeDate: true, adjClose: true },
      orderBy: { tradeDate: "asc" },
    });
    for (const p of prices) {
      const px = Number(p.adjClose);
      if (!Number.isFinite(px) || px <= 0) continue;
      (priceBySec.get(p.securityId) ?? priceBySec.set(p.securityId, []).get(p.securityId)!).push({ t: p.tradeDate.getTime(), px });
    }
  }
  for (const { ticker, period } of tickerPeriods) {
    const key = `${ticker}|${period}`;
    if (out.has(key)) continue;
    const secId = secIdByTicker.get(ticker);
    const series = secId ? priceBySec.get(secId) : undefined;
    if (!series) {
      out.set(key, { fwd1q: null, fwd2q: null });
      continue;
    }
    const entryMs = availabilityMs(period);
    const entryPx = priceAsOf(series, entryMs);
    const ret = (days: number): number | null => {
      if (entryPx == null) return null;
      const px = priceAsOf(series, entryMs + days * DAY);
      return px != null && px > 0 ? Math.round((px / entryPx - 1) * 1e4) / 1e4 : null;
    };
    out.set(key, { fwd1q: ret(HORIZON_1Q), fwd2q: ret(HORIZON_2Q) });
  }
  return out;
}

function median(vals: number[]): number | null {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Build the Originator Scoreboard as-of the latest quarter. Also returns the raw
 * per-fund outcomes (consumed by the fresh-calls feed and the fund page).
 */
export async function getFollowScoreboard(
  config: FundsAttributionConfig = FUNDS_ATTRIBUTION_CONFIG,
): Promise<FollowScoreboard | null> {
  const { index, periods } = await periodIndex();
  if (periods.length === 0) return null;
  const asOf = periods.length - 1;
  const latestPeriod = periods[asOf]!;

  const rawInits = await loadInitiationRows();
  if (rawInits.length === 0)
    return { filingPeriod: latestPeriod, rows: [], cohortMedianRate: null, outcomesByFund: new Map(), periods, initiations: [] };

  const fwd = await forwardReturns(rawInits.map((r) => ({ ticker: r.ticker, period: r.period })));
  const initiations: Initiation[] = rawInits
    .filter((r) => index.has(r.period))
    .map((r) => {
      const q = index.get(r.period)!;
      const f = fwd.get(`${r.ticker}|${r.period}`) ?? { fwd1q: null, fwd2q: null };
      return { fundId: r.fundId, ticker: r.ticker, quarter: q, strength: r.strength, sector: r.sector, fwd1q: f.fwd1q, fwd2q: f.fwd2q };
    });

  // Follow-vote pool: signal-tier NEW positions ≥ the materiality floor (asymmetric bar).
  const rawVotes = await loadFollowerRows(config.follow_min_bps);
  const followers: FollowerVote[] = rawVotes
    .filter((r) => index.has(r.period))
    .map((r) => ({ fundId: r.fundId, ticker: r.ticker, quarter: index.get(r.period)!, entryBps: r.entryBps }));

  const attr = computeFollowAttribution(initiations, followers, config, asOf);

  // Per-fund outcomes for meters + fresh + downstream consumers.
  const outcomesByFund = new Map<string, InitiationOutcome[]>();
  const windowStart = asOf - config.stat_window + 1;
  for (const o of attr.outcomes) {
    if (o.quarter < windowStart) continue;
    (outcomesByFund.get(o.fundId) ?? outcomesByFund.set(o.fundId, []).get(o.fundId)!).push(o);
  }

  // Fund metadata.
  const fundIds = attr.funds.map((f) => f.fundId);
  const meta = await prisma.institutionalFund.findMany({
    where: { id: { in: fundIds } },
    select: { id: true, cik: true, name: true, category: true, isMostRespected: true },
  });
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const rows: ScoreboardRow[] = attr.funds
    .map((f): ScoreboardRow | null => {
      const m = metaById.get(f.fundId);
      if (!m) return null;
      const os = outcomesByFund.get(f.fundId) ?? [];
      const followedBlocks = os.filter((o) => o.status === "followed").length;
      const resolvedBlocks = os.filter((o) => o.status === "followed" || o.status === "not_followed").length;
      const pendingBlocks = os.filter((o) => o.status === "pending").length;
      const freshTickers = [
        ...new Set(os.filter((o) => o.status === "pending" && o.followerFunds === 0).map((o) => o.ticker)),
      ];
      return {
        fundId: f.fundId,
        cik: m.cik,
        name: m.name,
        category: m.category,
        isElite: m.isMostRespected,
        n: f.n,
        followed: f.followed,
        followRate: f.followRate,
        medianLead: f.medianLead,
        fwd2q: f.fwd2q,
        hitRate2q: f.hitRate2q,
        bestSector: f.bestSector,
        bestSectorRate: f.bestSectorRate,
        trendRecent: f.trendRecent,
        trendPrior: f.trendPrior,
        rateSufficient: f.rateSufficient,
        meter: { n: resolvedBlocks, f: followedBlocks, pending: pendingBlocks },
        freshTickers,
      };
    })
    .filter((r): r is ScoreboardRow => r !== null)
    .sort((a, b) => {
      // Sufficient-rate funds first, then by follow rate desc, then n desc.
      if (a.rateSufficient !== b.rateSufficient) return a.rateSufficient ? -1 : 1;
      return (b.followRate ?? -1) - (a.followRate ?? -1) || b.n - a.n || a.name.localeCompare(b.name);
    });

  const cohortMedianRate = median(rows.filter((r) => r.rateSufficient && r.followRate != null).map((r) => r.followRate!));

  return { filingPeriod: latestPeriod, rows, cohortMedianRate, outcomesByFund, periods, initiations };
}
