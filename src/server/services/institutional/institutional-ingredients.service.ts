/**
 * Engine 3 — Flow Leaderboard config-INDEPENDENT ingredient precompute.
 *
 * Runs after the name/sector aggregates in the quarterly job. For every adjacent
 * quarter pair over the signal-tier universe it:
 *   1. Detects splits (raw cross-sectional holder ratio + implied-price
 *      corroboration) and writes derived CorporateAction rows / UNRESOLVED_SPLIT
 *      data holds. Never guesses.
 *   2. Split-ADJUSTS prior shares (using all known corporate actions) so both the
 *      QoQ share delta and the active/expected weight math are split-neutral —
 *      a 2:1 split is not a false wave of adders, and the counterfactual value
 *      isn't halved.
 *   3. Writes per-(fund,ticker,quarter) ingredients onto FundHoldingSnapshot:
 *      adjShareDeltaPct, activeWeightBps, expectedWeightBps.
 * Finally bumps `ingredients_version` (the leaderboard route cache key).
 *
 * The per-name netflowBps and point-in-time marketCapUsd are written by the name
 * aggregate pass (they piggyback on the active-flow metrics already computed there).
 *
 * BACKLOG — liquidity ingredients (adv_20d, days_to_exit): the leaderboard's LIQ
 * column, the crowding scatter, and a future exit-stress view all want a
 * per-(ticker,quarter) liquidity horizon = combined signal-tier position / 20-day
 * ADV at 20% participation (formula ported from pnl.service.ts getAdv20d /
 * daysToLiquidate). Precompute it HERE (versioned like marketCapUsd), not in the
 * flows read path, so it is computed once and shared. It needs ticker→securityId
 * resolution against the security master — the SAME mapping the taxonomy work
 * (rotation spec Part 2) adds — so sequence this AFTER that lands to build the join
 * once. Deferred from the Part 2 leaderboard UI on purpose.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { FLOW_LEADERBOARD_CONFIG } from "@/domain/calculations/flow-leaderboard-config";
import { computePerFundActiveWeights, type FundHoldingsByPeriod } from "./institutional-active-flow.service";
import { signalFundFilter } from "./institutional-aggregate.service";
import { detectSplit, type ContinuingHolder } from "./split-detect.service";

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
const dateOf = (p: string): Date => new Date(`${p}T00:00:00.000Z`);

/** Load one period's signal-tier long-equity holdings as fundId → ticker → {shares,value}. */
async function loadSignalHoldings(period: string): Promise<FundHoldingsByPeriod> {
  const rows = await prisma.$queryRaw<Array<{ fundId: string; ticker: string; shares: number; value: number }>>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h.shares::float8 AS shares, h.value::float8 AS value
    FROM "FundHoldingSnapshot" h
    WHERE h."filingPeriod" = ${period}::date AND h.shares > 0 AND ${signalFundFilter("h")}`);
  const out: FundHoldingsByPeriod = new Map();
  for (const r of rows) {
    let m = out.get(r.fundId);
    if (!m) out.set(r.fundId, (m = new Map()));
    m.set(r.ticker, { shares: r.shares, value: r.value });
  }
  return out;
}

/** Known split ratios keyed `${ticker}|${period}` (period = the quarter the split lands on). */
async function loadKnownSplits(): Promise<Map<string, number>> {
  const rows = await prisma.corporateAction.findMany({ select: { ticker: true, exDate: true, ratio: true } });
  const m = new Map<string, number>();
  for (const r of rows) m.set(`${r.ticker}|${iso(r.exDate)}`, r.ratio);
  return m;
}

/** Detect a split for one ticker at one quarter boundary from continuing signal holders. */
function continuingHolders(prev: FundHoldingsByPeriod, cur: FundHoldingsByPeriod, ticker: string): ContinuingHolder[] {
  const hs: ContinuingHolder[] = [];
  for (const [fundId, curH] of cur) {
    const c = curH.get(ticker);
    const p = prev.get(fundId)?.get(ticker);
    if (c && p && c.shares > 0 && p.shares > 0) hs.push({ fundId, prevShares: p.shares, curShares: c.shares, prevValue: p.value, curValue: c.value });
  }
  return hs;
}

export async function runIngredientPrecompute(log: (m: string) => void): Promise<{ periods: number; splitsDetected: number; unresolved: number }> {
  const periodRows = await prisma.$queryRaw<Array<{ p: Date }>>(Prisma.sql`
    SELECT DISTINCT "filingPeriod" AS p FROM "FundHoldingSnapshot" ORDER BY p ASC`);
  const periods = periodRows.map((r) => iso(r.p));
  const known = await loadKnownSplits();

  let splitsDetected = 0;
  let unresolved = 0;
  let prev: FundHoldingsByPeriod | null = null;
  let prevPeriod: string | null = null;

  type Upd = { fundId: string; ticker: string; period: string; adj: number | null; active: number | null; expected: number | null };
  const updates: Upd[] = [];

  for (const period of periods) {
    const cur = await loadSignalHoldings(period);
    if (prev && prevPeriod) {
      // ── 1. Split detection for every ticker held in both quarters. ──
      const tickers = new Set<string>();
      for (const h of cur.values()) for (const t of h.keys()) tickers.add(t);
      for (const ticker of tickers) {
        if (known.has(`${ticker}|${period}`)) continue; // already known (vendor/derived/manual)
        const hs = continuingHolders(prev, cur, ticker);
        if (hs.length < FLOW_LEADERBOARD_CONFIG.split_detect.min_funds) continue;
        const verdict = detectSplit(hs);
        if (verdict.kind === "split") {
          known.set(`${ticker}|${period}`, verdict.ratio);
          splitsDetected++;
          await prisma.corporateAction.upsert({
            where: { ticker_exDate_source: { ticker, exDate: dateOf(period), source: "derived" } },
            create: { ticker, exDate: dateOf(period), ratio: verdict.ratio, source: "derived", confidence: verdict.confidence, nFunds: verdict.nFunds },
            update: { ratio: verdict.ratio, confidence: verdict.confidence, nFunds: verdict.nFunds },
          });
          await prisma.dataQualityEvent.create({
            data: { kind: "derived_split", ticker, period: dateOf(period), payload: { ratio: verdict.ratio, confidence: verdict.confidence, nFunds: verdict.nFunds } },
          });
        } else if (verdict.kind === "unresolved") {
          unresolved++;
          await prisma.dataQualityEvent.create({
            data: { kind: "unresolved_split", ticker, period: dateOf(period), payload: { ratio: verdict.ratio, agreement: verdict.agreement, nFunds: verdict.nFunds, why: verdict.why } },
          });
        }
      }

      // ── 2. Split-adjust prior shares (all known splits at this boundary). ──
      const adjPrev: FundHoldingsByPeriod = new Map();
      for (const [fundId, holdings] of prev) {
        const m = new Map<string, { shares: number; value: number }>();
        for (const [t, h] of holdings) {
          const ratio = known.get(`${t}|${period}`) ?? 1;
          m.set(t, { shares: h.shares * ratio, value: h.value });
        }
        adjPrev.set(fundId, m);
      }

      // ── 3. Per-fund active/expected weights (on split-adjusted prev). ──
      const weights = computePerFundActiveWeights(adjPrev, cur);
      for (const [fundId, curH] of cur) {
        const prevH = adjPrev.get(fundId);
        for (const [ticker, h] of curH) {
          const adjPrevShares = prevH?.get(ticker)?.shares;
          const adj = adjPrevShares && adjPrevShares > 0 ? (h.shares / adjPrevShares - 1) * 100 : null;
          const w = weights.get(`${fundId}|${ticker}`);
          updates.push({ fundId, ticker, period, adj: adj === null ? null : Math.round(adj * 100) / 100, active: w?.activeWeightBps ?? null, expected: w?.expectedWeightBps ?? null });
        }
      }
    }
    prev = cur;
    prevPeriod = period;
  }

  // ── Bulk-write the per-fund ingredient columns. ──
  const CHUNK = 5000;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await prisma.$executeRaw`
      UPDATE "FundHoldingSnapshot" AS h
      SET "adjShareDeltaPct" = v.adj,
          "activeWeightBps" = v.active,
          "expectedWeightBps" = v.expected
      FROM (
        SELECT * FROM unnest(
          ${slice.map((u) => u.fundId)}::text[],
          ${slice.map((u) => u.ticker)}::text[],
          ${slice.map((u) => u.period)}::text[],
          ${slice.map((u) => u.adj)}::double precision[],
          ${slice.map((u) => u.active)}::double precision[],
          ${slice.map((u) => u.expected)}::double precision[]
        ) AS t(fund_id, ticker, period, adj, active, expected)
      ) AS v
      WHERE h."fundId" = v.fund_id AND h.ticker = v.ticker AND h."filingPeriod" = v.period::date`;
  }

  await bumpIngredientsVersion();
  log(`[institutional-agg] ingredients: ${updates.length} fund-rows, ${splitsDetected} derived splits, ${unresolved} unresolved holds`);
  return { periods: periods.length, splitsDetected, unresolved };
}

/** Monotonic ingredients version — consumed by the leaderboard route cache key. */
export async function bumpIngredientsVersion(): Promise<number> {
  const row = await prisma.institutionalMeta.findUnique({ where: { key: "ingredients_version" } });
  const next = (row ? Number(row.value) || 0 : 0) + 1;
  await prisma.institutionalMeta.upsert({
    where: { key: "ingredients_version" },
    create: { key: "ingredients_version", value: String(next) },
    update: { value: String(next) },
  });
  return next;
}

export async function getIngredientsVersion(): Promise<number> {
  const row = await prisma.institutionalMeta.findUnique({ where: { key: "ingredients_version" } });
  return row ? Number(row.value) || 0 : 0;
}
