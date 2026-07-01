/**
 * Engine 3 — aggregation / diff layer.
 *
 * Runs AFTER ingestion. Three passes:
 *   1. diff   — per fund, compare each period to the fund's prior filing period;
 *               set each holding's action (NEW/ADDED/HELD/TRIMMED) + prevShares,
 *               and synthesize EXITED rows (shares=0) for names dropped that Q.
 *   2. name   — per (ticker, period) over the tracked watchlist ∩ universe:
 *               raw counts, breadth (% of tracked funds), median % of book
 *               (conviction), Δ holders, trajectory label, quadrant, deciles.
 *   3. sector — roll name flows up to the platform's sector taxonomy.
 * Then caches the latest-quarter landing payload.
 *
 * Every stored number is raw or a transparent label — NO blended score.
 */
import { prisma } from "@/infrastructure/db/client";
import { fetchMarketCapsBatch } from "@/infrastructure/providers/fmp/institutional";
import { Prisma, RevisionGroupType } from "@prisma/client";

const iso = (d: Date | string): string =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/**
 * Breadth line (as % of tracked funds) above which a name is "broadly held".
 * This is a VISIBLE display threshold drawn on the quadrant x-axis (matching the
 * design mockup), not a hidden score — a name held by ≥25% of the tracked funds
 * is broadly owned; combined with high conviction that is the crowded / late-trade
 * corner. Adjustable if the watchlist size changes the interpretation.
 */
export const CROWDED_BREADTH_PCT = 25;

/**
 * Funds reporting more long-equity positions than this in a period are treated as
 * broadly-diversified / quant-style books (e.g. Marshall Wace ~2,600 names, Ancora
 * ~2,150) that hold a large slice of the whole market. Their presence in a name is
 * NOT a conviction signal: counting them inflates breadth (nearly every name clears
 * the ≥2-funds bar) and drags the conviction median toward zero. They are excluded
 * from the breadth denominator and the per-name holder / conviction counts (but stay
 * visible in the single-name ledger). Tune if the watchlist composition changes —
 * at 1000 this excludes only the two market-wide quant books; Gabelli (~950) stays.
 */
export const DIVERSIFIED_FUND_MAX_HOLDINGS = 1000;

/**
 * SQL predicate — TRUE when the row's fund is NOT a broadly-diversified filer that
 * period (correlated on fund + filing period). `alias` is the FundHoldingSnapshot
 * alias used by the outer query; it is a hardcoded literal, never user input.
 */
export function notDiversifiedFilter(alias: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "FundHoldingSnapshot" hd
    WHERE hd."fundId" = ${Prisma.raw(`${alias}."fundId"`)}
      AND hd."filingPeriod" = ${Prisma.raw(`${alias}."filingPeriod"`)}
      AND hd.shares > 0
    GROUP BY hd."fundId"
    HAVING count(*) > ${DIVERSIFIED_FUND_MAX_HOLDINGS})`;
}

/** Minimum net holder swing for a name to count toward the headline tiles. */
const MEANINGFUL_HOLDER_SWING = 2;

/** Market-cap → tier tag. Thresholds in USD. */
export function marketCapTier(mc: number | null): string | null {
  if (mc === null || !Number.isFinite(mc) || mc <= 0) return null;
  if (mc >= 200e9) return "mega";
  if (mc >= 10e9) return "large";
  if (mc >= 2e9) return "mid";
  return "small";
}

// ─── Pass 1: diff (set action + prevShares, synthesize EXITED rows) ─────────
async function diffFund(fundId: string, log: (m: string) => void): Promise<void> {
  // Clear any prior synthetic EXITED rows so re-runs stay idempotent.
  await prisma.fundHoldingSnapshot.deleteMany({ where: { fundId, action: "EXITED" } });

  const rows = await prisma.fundHoldingSnapshot.findMany({
    where: { fundId },
    select: { id: true, ticker: true, filingPeriod: true, shares: true, cik: true },
    orderBy: { filingPeriod: "asc" },
  });
  if (rows.length === 0) return;

  // Group by period; ordered list of periods.
  const byPeriod = new Map<string, Array<{ id: string; ticker: string; shares: number }>>();
  const cik = rows[0]!.cik;
  for (const r of rows) {
    const p = iso(r.filingPeriod);
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p)!.push({ id: r.id, ticker: r.ticker, shares: Number(r.shares) });
  }
  const periods = Array.from(byPeriod.keys()).sort();

  const updates: Array<{ id: string; action: string; prev: number | null }> = [];
  const exits: Prisma.FundHoldingSnapshotCreateManyInput[] = [];

  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    const cur = byPeriod.get(p)!;
    const prevP = i > 0 ? periods[i - 1]! : null;
    const prevMap = prevP
      ? new Map(byPeriod.get(prevP)!.map((h) => [h.ticker, h.shares]))
      : null;

    for (const h of cur) {
      if (!prevMap) {
        // Earliest known period → baseline; can't infer NEW without prior data.
        updates.push({ id: h.id, action: "HELD", prev: null });
        continue;
      }
      const prevShares = prevMap.get(h.ticker);
      if (prevShares === undefined) {
        updates.push({ id: h.id, action: "NEW", prev: null });
      } else if (h.shares > prevShares * 1.001) {
        updates.push({ id: h.id, action: "ADDED", prev: prevShares });
      } else if (h.shares < prevShares * 0.999) {
        updates.push({ id: h.id, action: "TRIMMED", prev: prevShares });
      } else {
        updates.push({ id: h.id, action: "HELD", prev: prevShares });
      }
    }

    // Exits: tickers in the prior period that are gone this period.
    if (prevMap) {
      const curSet = new Set(cur.map((h) => h.ticker));
      for (const [ticker, prevShares] of prevMap) {
        if (!curSet.has(ticker)) {
          exits.push({
            fundId,
            cik,
            filingPeriod: new Date(`${p}T00:00:00.000Z`),
            ticker,
            shares: "0",
            value: "0",
            pctOfBook: 0,
            action: "EXITED",
            prevShares: prevShares.toFixed(2),
          });
        }
      }
    }
  }

  // Bulk-apply action + prevShares in one set-based statement per chunk.
  const CHUNK = 5000;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const ids = slice.map((u) => u.id);
    const actions = slice.map((u) => u.action);
    const prevs = slice.map((u) => (u.prev === null ? null : u.prev));
    await prisma.$executeRaw`
      UPDATE "FundHoldingSnapshot" AS h
      SET action = v.action::"InstitutionalAction",
          "prevShares" = v.prev
      FROM (
        SELECT * FROM unnest(${ids}::text[], ${actions}::text[], ${prevs}::double precision[])
        AS t(id, action, prev)
      ) AS v
      WHERE h.id = v.id`;
  }
  if (exits.length) {
    for (let i = 0; i < exits.length; i += CHUNK) {
      await prisma.fundHoldingSnapshot.createMany({ data: exits.slice(i, i + CHUNK) });
    }
  }
  log(`[institutional-agg] diff ${cik}: ${updates.length} rows, ${exits.length} exits`);
}

// ─── Pass 2/3: name + sector aggregates ─────────────────────────────────────
type NameStat = {
  ticker: string;
  period: string;
  fundsHolding: number;
  fundsNew: number;
  fundsAdded: number;
  fundsHeld: number;
  fundsTrimmed: number;
  fundsExited: number;
  medianPctBook: number | null;
  totalValue: number | null;
};

/** Trajectory classification over the holder-count series (transparent rules). */
export function classifyTrajectory(series: number[]): string | null {
  const s = series.filter((n) => Number.isFinite(n));
  if (s.length < 3) return null;
  const first = s[0]!;
  const last = s[s.length - 1]!;
  const deltas: number[] = [];
  for (let i = 1; i < s.length; i++) deltas.push(s[i]! - s[i - 1]!);
  const up = deltas.filter((d) => d > 0).length;
  const net = last - first;
  const maxD = Math.max(...deltas);
  const lastD = deltas[deltas.length - 1]!;
  const priorDeltas = deltas.slice(0, -1);
  const priorAvg = priorDeltas.length ? priorDeltas.reduce((a, b) => a + b, 0) / priorDeltas.length : 0;

  // Spike: the final quarter jumps well above an otherwise flat/declining trend.
  if (lastD === maxD && lastD >= 3 && lastD >= (Math.abs(priorAvg) + 1) * 3 && net > 0) {
    return "spike";
  }
  // Durable: net rising and mostly-monotonic across the window.
  if (net > 0 && up >= Math.ceil((s.length - 1) * 0.6)) {
    // Accelerating: recent half rises faster than the earlier half.
    const mid = Math.floor(deltas.length / 2);
    const earlyAvg = deltas.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid);
    const lateAvg = deltas.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, deltas.length - mid);
    if (lateAvg > earlyAvg * 1.5 && lateAvg > 0) return "accelerating";
    return "durable";
  }
  return "choppy";
}

/** Quadrant from raw axes vs within-period median thresholds. */
function classifyQuadrant(
  breadth: number,
  conviction: number | null,
  breadthMid: number,
  convictionMid: number,
): string {
  const hiB = breadth >= breadthMid;
  const hiC = (conviction ?? 0) >= convictionMid;
  if (!hiB && hiC) return "early";
  if (hiB && hiC) return "crowded";
  if (!hiB && !hiC) return "ignored";
  return "broad-low";
}

function decileOf(sortedAsc: number[], value: number): number {
  if (sortedAsc.length === 0) return 0;
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, Math.min(10, Math.ceil((lo / sortedAsc.length) * 10)));
}

async function buildNameAndSectorAggregates(log: (m: string) => void): Promise<{ periods: string[] }> {
  // Per-(ticker, period) raw stats, restricted to tracked-active ∩ universe.
  const stats = await prisma.$queryRaw<
    Array<{
      ticker: string;
      period: Date;
      funds_holding: bigint;
      funds_new: bigint;
      funds_added: bigint;
      funds_held: bigint;
      funds_trimmed: bigint;
      funds_exited: bigint;
      median_pct_book: number | null;
      total_value: Prisma.Decimal | null;
      sector: string | null;
      subsector: string | null;
      company_name: string | null;
    }>
  >(Prisma.sql`
    SELECT h.ticker,
           h."filingPeriod" AS period,
           count(*) FILTER (WHERE h.shares > 0) AS funds_holding,
           count(*) FILTER (WHERE h.action = 'NEW') AS funds_new,
           count(*) FILTER (WHERE h.action = 'ADDED') AS funds_added,
           count(*) FILTER (WHERE h.action = 'HELD' AND h.shares > 0) AS funds_held,
           count(*) FILTER (WHERE h.action = 'TRIMMED') AS funds_trimmed,
           count(*) FILTER (WHERE h.action = 'EXITED') AS funds_exited,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY h."pctOfBook")
             FILTER (WHERE h.shares > 0 AND h."pctOfBook" IS NOT NULL) AS median_pct_book,
           sum(h.value) FILTER (WHERE h.shares > 0) AS total_value,
           rr.sector, rr.subsector,
           COALESCE(rr."companyName", max(h."nameOfIssuer")) AS company_name
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true
    -- LEFT JOIN: keep held names that are NOT in the curated coverage universe
    -- (sub-$300M micro/small-caps where activist edge lives). Uncovered names
    -- get null sector/subsector and are excluded from sector rotation, but still
    -- surface in the quadrant / trajectory / overview so discovery isn't gated.
    LEFT JOIN "RevisionReference" rr ON rr.ticker = h.ticker
    -- Drop broadly-diversified quant books (see notDiversifiedFilter): a name
    -- held only by them is not a conviction signal.
    WHERE ${notDiversifiedFilter("h")}
    GROUP BY h.ticker, h."filingPeriod", rr.sector, rr.subsector, rr."companyName"`);

  // Denominator: tracked-active, non-diversified funds that filed each period.
  const denomRows = await prisma.$queryRaw<Array<{ period: Date; n: bigint }>>(Prisma.sql`
    SELECT h."filingPeriod" AS period, count(DISTINCT h."fundId") AS n
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true
    WHERE h.shares > 0 AND ${notDiversifiedFilter("h")}
    GROUP BY h."filingPeriod"`);
  const denom = new Map(denomRows.map((r) => [iso(r.period), Number(r.n)]));

  const meta = new Map<string, { sector: string | null; subsector: string | null; name: string | null }>();
  const byKey = new Map<string, NameStat>();
  const seriesByTicker = new Map<string, Map<string, number>>();
  const allPeriods = new Set<string>();

  for (const r of stats) {
    const period = iso(r.period);
    allPeriods.add(period);
    const ns: NameStat = {
      ticker: r.ticker,
      period,
      fundsHolding: Number(r.funds_holding),
      fundsNew: Number(r.funds_new),
      fundsAdded: Number(r.funds_added),
      fundsHeld: Number(r.funds_held),
      fundsTrimmed: Number(r.funds_trimmed),
      fundsExited: Number(r.funds_exited),
      medianPctBook: r.median_pct_book !== null ? Number(r.median_pct_book) : null,
      totalValue: r.total_value !== null ? Number(r.total_value) : null,
    };
    byKey.set(`${r.ticker}|${period}`, ns);
    meta.set(r.ticker, { sector: r.sector, subsector: r.subsector, name: r.company_name });
    if (!seriesByTicker.has(r.ticker)) seriesByTicker.set(r.ticker, new Map());
    seriesByTicker.get(r.ticker)!.set(period, ns.fundsHolding);
  }
  const periods = Array.from(allPeriods).sort();

  // Market-cap tiers for the held universe (current cap; tags are stable enough).
  const tickers = Array.from(meta.keys());
  let capMap = new Map<string, number>();
  try {
    capMap = await fetchMarketCapsBatch(tickers);
  } catch (e) {
    log(`[institutional-agg] market-cap batch failed (tiers null): ${e instanceof Error ? e.message : String(e)}`);
  }

  // Per-period thresholds (data-driven medians) + decile ladders.
  const perPeriodBreadth = new Map<string, number[]>();
  const perPeriodConv = new Map<string, number[]>();
  for (const p of periods) {
    perPeriodBreadth.set(p, []);
    perPeriodConv.set(p, []);
  }
  for (const ns of byKey.values()) {
    const d = denom.get(ns.period) ?? 1;
    const breadth = (ns.fundsHolding / d) * 100;
    if (ns.fundsHolding >= 2) perPeriodBreadth.get(ns.period)!.push(breadth);
    // Conviction threshold is the median of POSITIVE convictions — names whose
    // % of book rounds to ~0 (mega-caps with token positions) shouldn't drag the
    // "meaningful conviction" line down toward zero.
    if (ns.medianPctBook !== null && ns.medianPctBook > 0 && ns.fundsHolding >= 2)
      perPeriodConv.get(ns.period)!.push(ns.medianPctBook);
  }
  const median = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  // Breadth line is the fixed, visible "broadly held" threshold; conviction line
  // is the data-driven median of meaningful positions in the period.
  const breadthMid = new Map(periods.map((p) => [p, CROWDED_BREADTH_PCT]));
  const convMid = new Map(periods.map((p) => [p, median(perPeriodConv.get(p)!)]));
  const breadthSorted = new Map(periods.map((p) => [p, [...perPeriodBreadth.get(p)!].sort((a, b) => a - b)]));
  const convSorted = new Map(periods.map((p) => [p, [...perPeriodConv.get(p)!].sort((a, b) => a - b)]));

  // Assemble + write name aggregates.
  const nameRows: Prisma.InstitutionalNameAggregateCreateManyInput[] = [];
  for (const ns of byKey.values()) {
    const d = denom.get(ns.period) ?? 1;
    const breadth = (ns.fundsHolding / d) * 100;
    const series = seriesByTicker.get(ns.ticker)!;
    const idx = periods.indexOf(ns.period);
    const priorHolders = idx > 0 ? series.get(periods[idx - 1]!) ?? 0 : 0;
    // At the earliest backfilled quarter we have no prior data, so a true
    // quarter-over-quarter change is unknowable — report 0 rather than inflating
    // it to the full holder count (which would fake "new accumulation").
    const deltaHolders = idx > 0 ? ns.fundsHolding - priorHolders : 0;
    // Trajectory over the trailing 8 quarters up to this period.
    const window = periods.slice(Math.max(0, idx - 7), idx + 1).map((p) => series.get(p) ?? 0);
    const m = meta.get(ns.ticker)!;
    const mc = capMap.get(ns.ticker) ?? null;
    nameRows.push({
      ticker: ns.ticker,
      filingPeriod: new Date(`${ns.period}T00:00:00.000Z`),
      companyName: m.name,
      sector: m.sector,
      subsector: m.subsector,
      marketCapTier: marketCapTier(mc),
      fundsHolding: ns.fundsHolding,
      fundsNew: ns.fundsNew,
      fundsAdded: ns.fundsAdded,
      fundsHeld: ns.fundsHeld,
      fundsTrimmed: ns.fundsTrimmed,
      fundsExited: ns.fundsExited,
      fundsBought: ns.fundsNew + ns.fundsAdded,
      fundsSold: ns.fundsTrimmed + ns.fundsExited,
      deltaHolders,
      pctOfFunds: breadth,
      medianPctOfBook: ns.medianPctBook,
      totalValue: ns.totalValue !== null ? ns.totalValue.toFixed(2) : null,
      trajectoryLabel: classifyTrajectory(window),
      quadrant: classifyQuadrant(breadth, ns.medianPctBook, breadthMid.get(ns.period)!, convMid.get(ns.period)!),
      newArrival: idx > 0 && priorHolders === 0 && ns.fundsHolding > 0,
      breadthDecile: decileOf(breadthSorted.get(ns.period)!, breadth),
      convictionDecile: ns.medianPctBook !== null ? decileOf(convSorted.get(ns.period)!, ns.medianPctBook) : null,
    });
  }

  await prisma.$transaction([
    prisma.institutionalNameAggregate.deleteMany({}),
    ...chunk(nameRows, 5000).map((c) => prisma.institutionalNameAggregate.createMany({ data: c })),
  ]);
  log(`[institutional-agg] name aggregates: ${nameRows.length} rows across ${periods.length} periods`);

  // Sector rollup from the name aggregates.
  const sectorRows: Prisma.InstitutionalSectorAggregateCreateManyInput[] = [];
  const sectorMap = new Map<string, { adding: number; trimming: number; count: number; net: number }>();
  for (const nr of nameRows) {
    if (!nr.sector) continue;
    const key = `${nr.sector}|${iso(nr.filingPeriod as Date)}`;
    const e = sectorMap.get(key) ?? { adding: 0, trimming: 0, count: 0, net: 0 };
    e.adding += (nr.fundsBought ?? 0);
    e.trimming += (nr.fundsSold ?? 0);
    e.count += 1;
    sectorMap.set(key, e);
  }
  for (const [key, e] of sectorMap) {
    const [sector, period] = key.split("|");
    sectorRows.push({
      groupType: RevisionGroupType.SECTOR,
      groupKey: sector!,
      filingPeriod: new Date(`${period}T00:00:00.000Z`),
      netFundsAdding: e.adding - e.trimming,
      fundsAdding: e.adding,
      fundsTrimming: e.trimming,
      nameCount: e.count,
    });
  }
  await prisma.$transaction([
    prisma.institutionalSectorAggregate.deleteMany({}),
    ...chunk(sectorRows, 5000).map((c) => prisma.institutionalSectorAggregate.createMany({ data: c })),
  ]);
  log(`[institutional-agg] sector aggregates: ${sectorRows.length} rows`);

  return { periods };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export type AggregateResult = { fundsDiffed: number; periods: string[]; latestPeriod: string | null };

export async function runInstitutionalAggregate(opts: {
  log?: (msg: string) => void;
}): Promise<AggregateResult> {
  const log = opts.log ?? (() => {});
  const funds = await prisma.institutionalFund.findMany({ where: { isActive: true }, select: { id: true } });
  log(`[institutional-agg] diffing ${funds.length} funds`);
  for (const f of funds) await diffFund(f.id, log);

  const { periods } = await buildNameAndSectorAggregates(log);
  const latestPeriod = periods.length ? periods[periods.length - 1]! : null;

  // Cache the landing payload for the latest quarter.
  if (latestPeriod) {
    await cacheQuarterPayload(latestPeriod, periods, log);
  }
  return { fundsDiffed: funds.length, periods, latestPeriod };
}

/** Landing-page payload: change-detector tiles + top new accumulation. */
async function cacheQuarterPayload(period: string, periods: string[], log: (m: string) => void): Promise<void> {
  const periodDate = new Date(`${period}T00:00:00.000Z`);
  const rows = await prisma.institutionalNameAggregate.findMany({ where: { filingPeriod: periodDate } });
  const priorPeriod = periods.length >= 2 ? periods[periods.length - 2]! : null;

  const newAccumulation = rows.filter(
    (r) => r.deltaHolders >= MEANINGFUL_HOLDER_SWING && r.fundsBought > r.fundsSold,
  ).length;
  const newDistribution = rows.filter(
    (r) => r.deltaHolders <= -MEANINGFUL_HOLDER_SWING && r.fundsSold > r.fundsBought,
  ).length;
  // Crowded AND still being accumulated into = genuine late-trade risk.
  const crowdingAlerts = rows.filter((r) => r.quadrant === "crowded" && r.deltaHolders >= 0).length;
  const surfaced = rows.filter((r) => r.fundsHolding >= 2);
  const smallMid = surfaced.filter((r) => r.marketCapTier === "small" || r.marketCapTier === "mid").length;
  const smallMidShare = surfaced.length ? Math.round((smallMid / surfaced.length) * 100) : 0;

  let priorCounts = { acc: 0, dist: 0 };
  if (priorPeriod) {
    const prior = await prisma.institutionalNameAggregate.findMany({ where: { filingPeriod: new Date(`${priorPeriod}T00:00:00.000Z`) } });
    priorCounts.acc = prior.filter((r) => r.deltaHolders >= MEANINGFUL_HOLDER_SWING && r.fundsBought > r.fundsSold).length;
    priorCounts.dist = prior.filter((r) => r.deltaHolders <= -MEANINGFUL_HOLDER_SWING && r.fundsSold > r.fundsBought).length;
  }

  const topNew = rows
    .filter((r) => r.fundsBought > 0)
    .sort((a, b) => b.deltaHolders - a.deltaHolders || b.fundsBought - a.fundsBought)
    .slice(0, 25)
    .map((r) => ({
      ticker: r.ticker,
      companyName: r.companyName,
      sector: r.sector,
      marketCapTier: r.marketCapTier,
      fundsBought: r.fundsBought,
      fundsSold: r.fundsSold,
      pctOfFunds: Number(r.pctOfFunds.toFixed(1)),
      deltaHolders: r.deltaHolders,
    }));

  const payload = {
    filingPeriod: period,
    generatedAt: new Date().toISOString(),
    tiles: {
      newAccumulation,
      newAccumulationDelta: newAccumulation - priorCounts.acc,
      newDistribution,
      newDistributionDelta: newDistribution - priorCounts.dist,
      crowdingAlerts,
      smallMidShare,
    },
    topNew,
  };
  await prisma.institutionalQuarterSnapshot.upsert({
    where: { filingPeriod: periodDate },
    create: { filingPeriod: periodDate, payloadJson: payload as unknown as Prisma.InputJsonValue },
    update: { payloadJson: payload as unknown as Prisma.InputJsonValue, computedAt: new Date() },
  });
  log(`[institutional-agg] cached landing payload for ${period}`);
}
