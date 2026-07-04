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
import { buildActiveFlowMetrics, netDiffusionPct } from "./institutional-active-flow.service";
import { runIngredientPrecompute } from "./institutional-ingredients.service";
import { runCoreHoldingsPrecompute } from "./institutional-core-holdings.service";
import { runBaseRates } from "./institutional-base-rates.service";
import { FLOW_LEADERBOARD_CONFIG } from "@/domain/calculations/flow-leaderboard-config";
import { cumulativeAccSeries } from "@/domain/calculations/flow-trajectory";
import { classifyLifecycleSeries, detectTransitions, type StageInfo } from "@/domain/calculations/lifecycle";
import { classifySecurity, type SecurityClass } from "@/lib/institutional/security-class";

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
 *
 * DEPRECATED for flow denominators: superseded by `signalFundFilter` (the global
 * signal/context tier). Retained only for any diagnostic / migration comparison.
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

/**
 * SQL predicate — TRUE when the row's fund is an ACTIVE, SIGNAL-tier fund.
 * This is the SINGLE SOURCE OF TRUTH for the flow universe: breadth, netflow,
 * netflow_bps, conviction, crowding, diffusion, trajectory, and the leaderboard
 * all gate on this so their denominators agree. Context-tier / inactive funds
 * still ingest and appear in the single-name ledger, but never in flow denominators.
 * `alias` is the FundHoldingSnapshot alias; a hardcoded literal, never user input.
 */
export function signalFundFilter(alias: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "InstitutionalFund" f
    WHERE f.id = ${Prisma.raw(`${alias}."fundId"`)}
      AND f."isActive" = true
      AND f."tier" = 'signal')`;
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

/** Below this per-quarter |active move| (bps) the series is rebalancing dust with
 *  no meaningful accumulation — classified "choppy" regardless of shape. */
const NOISE_FLOOR_BPS = 2;

/**
 * Trajectory classification over the cumulative active-flow (bps) series — a
 * position-building curve where each step is that quarter's deliberate, price-
 * adjusted weight move. Rules are SCALE-FREE (ratios + an absolute bps noise
 * floor), so a mega-cap moving 30 bps and a micro-cap moving 30 bps that build
 * the same shape get the same label. Input is the cumsum levels; the per-quarter
 * flows are its first differences.
 */
export function classifyTrajectory(series: number[]): string | null {
  const s = series.filter((n) => Number.isFinite(n));
  if (s.length < 3) return null;
  const deltas: number[] = [];
  for (let i = 1; i < s.length; i++) deltas.push(s[i]! - s[i - 1]!);
  const n = deltas.length;

  const maxAbs = Math.max(...deltas.map((d) => Math.abs(d)));
  if (maxAbs < NOISE_FLOOR_BPS) return "choppy"; // no meaningful activity

  const net = s[s.length - 1]! - s[0]!;
  const up = deltas.filter((d) => d > 0).length;
  const maxD = Math.max(...deltas);
  const lastD = deltas[n - 1]!;
  const posSum = deltas.reduce((a, d) => a + Math.max(d, 0), 0);
  const meanAbs = deltas.reduce((a, d) => a + Math.abs(d), 0) / n;

  // Spike: the final quarter carries most of the build and dwarfs the typical move.
  if (net > 0 && lastD === maxD && lastD >= 0.6 * posSum && lastD >= 2 * meanAbs) {
    return "spike";
  }
  // Durable: net rising and mostly-monotonic across the window.
  if (net > 0 && up >= Math.ceil(n * 0.6)) {
    // Accelerating: recent half rises faster than the earlier half.
    const mid = Math.floor(n / 2);
    const earlyAvg = deltas.slice(0, mid).reduce((a, b) => a + b, 0) / Math.max(1, mid);
    const lateAvg = deltas.slice(mid).reduce((a, b) => a + b, 0) / Math.max(1, n - mid);
    if (lateAvg > earlyAvg * 1.5 && lateAvg > 0) return "accelerating";
    return "durable";
  }
  return "choppy";
}

/**
 * Signed accumulation/distribution streak per period from a holder-count series.
 * `holders[i]` is the fund count at period i, or null if the name was not in the
 * universe that quarter. Returns, per index, the number of consecutive quarters
 * (ending at that period) with the same-signed holder delta: +N accumulating,
 * −N distributing, 0 for a flat delta or the earliest quarter.
 *
 * Sign always matches sign(deltaHolders) (both use `holders[i] - (holders[i-1] ?? 0)`),
 * so a streak badge never contradicts a mark's flow color. A gap (null) resets the
 * run: a name that leaves and re-enters the universe restarts at ±1 rather than
 * continuing its old streak or erroring.
 */
export function streakSeries(holders: Array<number | null>): number[] {
  const out = new Array<number>(holders.length).fill(0);
  for (let i = 0; i < holders.length; i++) {
    const cur = holders[i];
    if (cur == null || i === 0) continue; // absent, or earliest quarter (delta unknowable)
    const prev = holders[i - 1];
    const d = cur - (prev ?? 0);
    if (d === 0) continue;
    const s = Math.sign(d);
    // Extend only across a present prior quarter whose streak carries the same sign.
    out[i] = prev != null && out[i - 1] !== 0 && Math.sign(out[i - 1]!) === s ? out[i - 1]! + s : s;
  }
  return out;
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
    -- LEFT JOIN: keep held names that are NOT in the curated coverage universe
    -- (sub-$300M micro/small-caps where activist edge lives). Uncovered names
    -- get null sector/subsector and are excluded from sector rotation, but still
    -- surface in the quadrant / trajectory / overview so discovery isn't gated.
    LEFT JOIN "RevisionReference" rr ON rr.ticker = h.ticker
    -- Signal-tier universe only (see signalFundFilter): context-tier / inactive
    -- funds ingest but never count toward a flow denominator.
    WHERE ${signalFundFilter("h")}
    GROUP BY h.ticker, h."filingPeriod", rr.sector, rr.subsector, rr."companyName"`);

  // Denominator: active signal-tier funds that filed each period.
  const denomRows = await prisma.$queryRaw<Array<{ period: Date; n: bigint }>>(Prisma.sql`
    SELECT h."filingPeriod" AS period, count(DISTINCT h."fundId") AS n
    FROM "FundHoldingSnapshot" h
    WHERE h.shares > 0 AND ${signalFundFilter("h")}
    GROUP BY h."filingPeriod"`);
  const denom = new Map(denomRows.map((r) => [iso(r.period), Number(r.n)]));

  // meta.sector / .subsector are the canonical GROUPING keys after classification
  // (vehicles → null so they drop out of sector rollups; uncovered names →
  // "Unclassified"). securityClass is stored on the name aggregate so the stock
  // view and leaderboard can exclude vehicles.
  const meta = new Map<string, { sector: string | null; subsector: string | null; name: string | null; securityClass: SecurityClass }>();
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
    const cls = classifySecurity(r.sector, r.subsector);
    meta.set(r.ticker, { sector: cls.groupSector, subsector: cls.groupSubsector, name: r.company_name, securityClass: cls.securityClass });
    if (!seriesByTicker.has(r.ticker)) seriesByTicker.set(r.ticker, new Map());
    seriesByTicker.get(r.ticker)!.set(period, ns.fundsHolding);
  }
  const periods = Array.from(allPeriods).sort();

  // Price-adjusted, equal-weighted active-rotation metric per (name|period) and
  // (groupType|groupKey|period). Reuses the sector/subsector taxonomy in `meta`.
  // Per-level materiality floors so rally-drift dust doesn't cast rotation votes.
  const mv = FLOW_LEADERBOARD_CONFIG.min_vote_bps;
  const activeFlow = await buildActiveFlowMetrics(periods, meta, log, {
    name: mv.stock,
    sector: mv.sector,
    subsector: mv.subsector,
  });

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

  // Precompute each ticker's signed holder-streak across the full period list
  // once (O(tickers × periods)), keyed period → streak, so the per-row loop stays
  // O(1) rather than recomputing the whole series per row.
  const streakByTicker = new Map<string, Map<string, number>>();
  for (const [ticker, series] of seriesByTicker) {
    const holders = periods.map((p) => series.get(p) ?? null);
    const streaks = streakSeries(holders);
    streakByTicker.set(ticker, new Map(periods.map((p, i) => [p, streaks[i]!])));
  }

  // Lifecycle stage per (ticker, period) from the SINGLE accumulation series
  // (Part 2): the per-quarter input is netBpsAllFunds (all signal funds). The
  // CROWDED escalation flag fires when breadth ≥ the cross-sectional p75 of that
  // period. Transition events feed the InstitutionalEvent stream.
  const p75Breadth = new Map(
    periods.map((p) => {
      const arr = breadthSorted.get(p)!;
      return [p, arr.length ? arr[Math.min(arr.length - 1, Math.floor(0.75 * (arr.length - 1)))]! : Infinity] as const;
    }),
  );
  const lifecycleByTicker = new Map<string, Map<string, StageInfo>>();
  const eventRows: Prisma.InstitutionalEventCreateManyInput[] = [];
  for (const [ticker, series] of seriesByTicker) {
    const perQuarterBps = periods.map((p) => activeFlow.byNamePeriod.get(`${ticker}|${p}`)?.netBpsAllFunds ?? 0);
    const crowdedFlags = periods.map((p) => {
      const holders = series.get(p);
      if (holders == null) return false;
      const breadth = (holders / (denom.get(p) ?? 1)) * 100;
      return holders >= 2 && breadth >= (p75Breadth.get(p) ?? Infinity);
    });
    const stages = classifyLifecycleSeries(perQuarterBps, crowdedFlags);
    lifecycleByTicker.set(ticker, new Map(periods.map((p, i) => [p, stages[i]!])));
    for (const ev of detectTransitions(stages)) {
      eventRows.push({
        kind: "stage_transition",
        ticker,
        filingPeriod: new Date(`${periods[ev.index]}T00:00:00.000Z`),
        significance: ev.significance,
        payload: { from: ev.from, to: ev.to, transition: ev.transition, streak: stages[ev.index]!.streak } as Prisma.InputJsonValue,
      });
    }
  }

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
    // Trajectory over the trailing 8 quarters up to this period — the CUMULATIVE
    // accumulation series (Part 1a): running sum of each quarter's deliberate
    // active move measured over ALL signal funds (netBpsAllFunds, non-holders =
    // 0), NOT the participant-only activeBpsAvg. Single implementation via
    // cumulativeAccSeries so leaderboard and trajectories read the same curve.
    const window = cumulativeAccSeries(
      periods.slice(Math.max(0, idx - 7), idx + 1).map((p) => activeFlow.byNamePeriod.get(`${ns.ticker}|${p}`)?.netBpsAllFunds ?? 0),
    );
    const af = activeFlow.byNamePeriod.get(`${ns.ticker}|${ns.period}`) ?? null;
    const m = meta.get(ns.ticker)!;
    const mc = capMap.get(ns.ticker) ?? null;
    nameRows.push({
      ticker: ns.ticker,
      filingPeriod: new Date(`${ns.period}T00:00:00.000Z`),
      companyName: m.name,
      sector: m.sector,
      subsector: m.subsector,
      securityClass: m.securityClass,
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
      holderStreak: streakByTicker.get(ns.ticker)!.get(ns.period) ?? 0,
      pctOfFunds: breadth,
      medianPctOfBook: ns.medianPctBook,
      totalValue: ns.totalValue !== null ? ns.totalValue.toFixed(2) : null,
      trajectoryLabel: classifyTrajectory(window),
      lifecycleStage: lifecycleByTicker.get(ns.ticker)?.get(ns.period)?.stage ?? null,
      crowded: lifecycleByTicker.get(ns.ticker)?.get(ns.period)?.crowded ?? false,
      quadrant: classifyQuadrant(breadth, ns.medianPctBook, breadthMid.get(ns.period)!, convMid.get(ns.period)!),
      newArrival: idx > 0 && priorHolders === 0 && ns.fundsHolding > 0,
      breadthDecile: decileOf(breadthSorted.get(ns.period)!, breadth),
      convictionDecile: ns.medianPctBook !== null ? decileOf(convSorted.get(ns.period)!, ns.medianPctBook) : null,
      activeBpsAvg: af?.activeBpsAvg ?? null,
      dollarNetFlow: af ? af.dollarNetFlow.toFixed(2) : null,
      fundsRotatedIn: af?.fundsIn ?? null,
      fundsRotatedOut: af?.fundsOut ?? null,
      fundsParticipating: af?.fundsParticipating ?? null,
      // Leaderboard ingredients: capital-flow bps (mean over all signal funds) and
      // point-in-time market cap (current cap; historical backfill is a follow-up).
      netflowBps: af?.netBpsAllFunds ?? null,
      marketCapUsd: mc !== null ? mc.toFixed(2) : null,
    });
  }

  await prisma.$transaction([
    prisma.institutionalNameAggregate.deleteMany({}),
    ...chunk(nameRows, 5000).map((c) => prisma.institutionalNameAggregate.createMany({ data: c })),
  ]);
  log(`[institutional-agg] name aggregates: ${nameRows.length} rows across ${periods.length} periods`);

  // Lifecycle transition events (Part 2). Idempotent: replace the stage_transition
  // slice each run (stasis_break events are written by the core-holdings pass).
  await prisma.$transaction([
    prisma.institutionalEvent.deleteMany({ where: { kind: "stage_transition" } }),
    ...chunk(eventRows, 5000).map((c) => prisma.institutionalEvent.createMany({ data: c })),
  ]);
  log(`[institutional-agg] lifecycle transitions: ${eventRows.length} events`);

  // Sector + subsector rollups from the name aggregates.
  const sectorRows: Prisma.InstitutionalSectorAggregateCreateManyInput[] = [];
  const groupings = [
    { groupType: RevisionGroupType.SECTOR, field: "sector" as const },
    { groupType: RevisionGroupType.SUBSECTOR, field: "subsector" as const },
  ];
  for (const { groupType, field } of groupings) {
    const groupMap = new Map<string, { adding: number; trimming: number; count: number }>();
    for (const nr of nameRows) {
      const groupKey = nr[field];
      if (!groupKey) continue;
      const key = `${groupKey}|${iso(nr.filingPeriod as Date)}`;
      const e = groupMap.get(key) ?? { adding: 0, trimming: 0, count: 0 };
      e.adding += (nr.fundsBought ?? 0);
      e.trimming += (nr.fundsSold ?? 0);
      e.count += 1;
      groupMap.set(key, e);
    }
    for (const [key, e] of groupMap) {
      const [groupKey, period] = key.split("|");
      // Active-flow metrics come from the fund-level math (not a re-sum of the
      // name rows — per-fund sector weights don't decompose into per-name means).
      const af = activeFlow.byGroupPeriod.get(`${groupType}|${groupKey}|${period}`);
      sectorRows.push({
        groupType,
        groupKey: groupKey!,
        filingPeriod: new Date(`${period}T00:00:00.000Z`),
        netFundsAdding: e.adding - e.trimming,
        fundsAdding: e.adding,
        fundsTrimming: e.trimming,
        nameCount: e.count,
        netValueFlow: af ? af.dollarNetFlow.toFixed(2) : null,
        aggregatesJson: af
          ? {
              activeFlow: {
                activeBpsAvg: af.activeBpsAvg,
                netDiffusionPct: netDiffusionPct(af),
                fundsIn: af.fundsIn,
                fundsOut: af.fundsOut,
                fundsParticipating: af.fundsParticipating,
                fundsEvaluated: af.fundsEvaluated,
              },
            }
          : Prisma.JsonNull,
      });
    }
  }
  await prisma.$transaction([
    prisma.institutionalSectorAggregate.deleteMany({}),
    ...chunk(sectorRows, 5000).map((c) => prisma.institutionalSectorAggregate.createMany({ data: c })),
  ]);
  log(`[institutional-agg] sector/subsector aggregates: ${sectorRows.length} rows`);

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

  // Config-independent leaderboard ingredients + split detection (bumps the
  // ingredients_version that keys the leaderboard route cache).
  await runIngredientPrecompute(log);

  // Core Holdings (Part 3): tenure, endorsement, stasis-break events. Runs after
  // ingredients so it reads the diffed/split-adjusted holding history.
  await runCoreHoldingsPrecompute(log);

  // Forward-return base rates + calibration sweep (Part 4). Reads split-adjusted
  // closes; no lookahead (entry = filing date). Best-effort — a missing price
  // history must not fail the whole aggregate.
  try {
    await runBaseRates(log);
  } catch (e) {
    log(`[institutional-agg] base rates skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  const latestPeriod = periods.length ? periods[periods.length - 1]! : null;

  // Cache the landing payload for every quarter (not just the latest) so a
  // historical period selection also gets the rotation tiles + QoQ deltas. Slice
  // keeps `priorPeriod` correct for each (cacheQuarterPayload reads periods[-2]).
  for (let i = 0; i < periods.length; i++) {
    await cacheQuarterPayload(periods[i]!, periods.slice(0, i + 1), log);
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

  const priorCounts = { acc: 0, dist: 0 };
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

  // Rotation diffusion tiles — the sectors the broadest set of funds deliberately
  // rotated into / out of this quarter (price-adjusted). Null before any prior Q.
  type AF = { activeBpsAvg: number; netDiffusionPct: number; fundsIn: number; fundsOut: number; fundsParticipating: number; fundsEvaluated: number };
  const sectorRows = await prisma.institutionalSectorAggregate.findMany({
    where: { filingPeriod: periodDate, groupType: "SECTOR" },
  });
  const withAf = sectorRows
    .map((r) => {
      const af = (r.aggregatesJson as unknown as { activeFlow?: AF } | null)?.activeFlow;
      return af ? { groupKey: r.groupKey, af, dollar: r.netValueFlow !== null ? Number(r.netValueFlow) : 0 } : null;
    })
    .filter((x): x is { groupKey: string; af: AF; dollar: number } => x !== null);
  const toTile = (x: { groupKey: string; af: AF; dollar: number }) => ({
    groupKey: x.groupKey,
    netDiffusionPct: x.af.netDiffusionPct,
    activeBpsAvg: x.af.activeBpsAvg,
    dollarNetFlow: x.dollar,
  });
  const inflow = withAf.filter((x) => x.af.netDiffusionPct > 0).sort((a, b) => b.af.netDiffusionPct - a.af.netDiffusionPct)[0];
  const outflow = withAf.filter((x) => x.af.netDiffusionPct < 0).sort((a, b) => a.af.netDiffusionPct - b.af.netDiffusionPct)[0];
  const rotation = {
    broadestInflow: inflow ? toTile(inflow) : null,
    broadestOutflow: outflow ? toTile(outflow) : null,
  };

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
    rotation,
  };
  await prisma.institutionalQuarterSnapshot.upsert({
    where: { filingPeriod: periodDate },
    create: { filingPeriod: periodDate, payloadJson: payload as unknown as Prisma.InputJsonValue },
    update: { payloadJson: payload as unknown as Prisma.InputJsonValue, computedAt: new Date() },
  });
  log(`[institutional-agg] cached landing payload for ${period}`);
}
