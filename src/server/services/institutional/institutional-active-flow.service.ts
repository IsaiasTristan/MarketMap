/**
 * Engine 3 — price-adjusted, equal-weighted "active rotation" metric.
 *
 * The rotation views used to count holder actions (funds adding minus trimming).
 * That conflates a sector that merely rallied (weights drift up on price alone,
 * nobody bought anything) with a sector managers deliberately rotated into. This
 * module measures the DELIBERATE move:
 *
 *   For each fund, sector weight change quarter-over-quarter, MINUS the change
 *   prices alone would have caused (revalue last quarter's shares at this
 *   quarter's prices), averaged EQUAL-WEIGHTED across funds — each manager's
 *   book is one vote, so no single whale can paint a sector.
 *
 * Three numbers per bucket (sector / subsector / name):
 *   - activeBpsAvg    — the average fund's deliberate move, in bps of book.
 *   - diffusion       — how many funds moved the same direction (fundsIn/Out over
 *                       participating), so a broad migration is distinguishable
 *                       from one fund's reallocation.
 *   - dollarNetFlow   — the net capital added/removed, for dollar intuition.
 *
 * Prices are implied per name as median(value / shares) across funds (shares > 0);
 * options/short rows are already excluded at ingest, so this is a clean long-equity
 * price. No external price feed is needed and 13F-only names are covered.
 *
 * The core (`computeActiveFlowPair`) is pure and DB-free for unit testing; the
 * loader (`buildActiveFlowMetrics`) streams two adjacent quarters at a time.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { signalFundFilter } from "./institutional-aggregate.service";

/** Diffusion dead-band: |active move| below this (bps) is rebalancing dust, not a
 *  deliberate rotation, and doesn't count toward fundsIn / fundsOut. */
export const ACTIVE_FLOW_EPS_BPS = 1;

export type HoldingLite = { shares: number; value: number };
/** fundId → (ticker → { shares, value }) for a single quarter. */
export type FundHoldingsByPeriod = Map<string, Map<string, HoldingLite>>;

// Book denominator note: we use each fund's tracked long-equity book (Σ holding
// values) for BOTH the actual and the counterfactual weight, rather than the
// reported 13F marketValue. Options/shorts are already excluded at ingest, so this
// is the equity book the rotation is measured within — and using one consistent
// basis for w and ŵ keeps the per-fund active moves conserving (Σ over sectors ≈ 0)
// and avoids a denominator mismatch. In real 13F data marketValue ≈ Σ holdings.
/** ticker → { sector, subsector }; nulls kept in book denominators, out of buckets.
 *  ReadonlyMap so a richer meta map (with extra fields) is covariantly assignable. */
export type SectorMeta = ReadonlyMap<string, { sector: string | null; subsector: string | null }>;

export interface ActiveFlowStat {
  activeBpsAvg: number; // group: mean over all evaluated funds; name: mean over participating funds
  netBpsAllFunds: number; // mean (active − expected) weight over ALL evaluated funds (non-holders = 0)
  fundsIn: number; // active move > +ε
  fundsOut: number; // active move < −ε
  fundsParticipating: number; // funds with exposure at t−1 or t (diffusion denominator)
  fundsEvaluated: number; // |F| for this pair (all funds present both quarters, book > 0)
  dollarNetFlow: number; // Σ (curValue − prevShares·priceₜ)
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A fund's tracked long-equity book = Σ holding values. */
function bookOf(holdings: Map<string, HoldingLite>): number {
  let s = 0;
  for (const h of holdings.values()) s += h.value;
  return s;
}

type GroupAcc = { sumDelta: number; fundsIn: number; fundsOut: number; participating: number; dollar: number };
function emptyAcc(): GroupAcc {
  return { sumDelta: 0, fundsIn: 0, fundsOut: 0, participating: 0, dollar: 0 };
}

/**
 * Compute active-flow stats for one adjacent quarter pair (t−1 → t).
 * Pure: no DB access, no clock. Returns per-name and per-group (sector/subsector) stats.
 */
export function computeActiveFlowPair(
  prev: FundHoldingsByPeriod,
  cur: FundHoldingsByPeriod,
  meta: SectorMeta,
): { byName: Map<string, ActiveFlowStat>; byGroup: Map<string, ActiveFlowStat>; skippedPrices: number } {
  // ── implied price per ticker at t: median(value/shares); fall back to t−1. ──
  const curPx = new Map<string, number[]>();
  const prevPx = new Map<string, number[]>();
  const collect = (src: FundHoldingsByPeriod, into: Map<string, number[]>) => {
    for (const holdings of src.values()) {
      for (const [t, h] of holdings) {
        if (h.shares > 0) {
          if (!into.has(t)) into.set(t, []);
          into.get(t)!.push(h.value / h.shares);
        }
      }
    }
  };
  collect(cur, curPx);
  collect(prev, prevPx);
  const priceAt = new Map<string, number>();
  for (const t of new Set([...curPx.keys(), ...prevPx.keys()])) {
    const p = median(curPx.get(t) ?? []) ?? median(prevPx.get(t) ?? []);
    if (p !== null) priceAt.set(t, p);
  }

  const nameAcc = new Map<string, GroupAcc>();
  const groupAcc = new Map<string, GroupAcc>(); // key: `${groupType}|${groupKey}`
  let fundsEvaluated = 0;
  let skippedPrices = 0;

  const bump = (map: Map<string, GroupAcc>, key: string): GroupAcc => {
    let a = map.get(key);
    if (!a) {
      a = emptyAcc();
      map.set(key, a);
    }
    return a;
  };

  // Fund set F = present both quarters with a positive actual and counterfactual book.
  for (const [fundId, curHoldings] of cur) {
    const prevHoldings = prev.get(fundId);
    if (!prevHoldings) continue;

    const book = bookOf(curHoldings);
    if (book <= 0) continue;
    // Counterfactual book = last quarter's shares revalued at this quarter's prices.
    let cfBook = 0;
    for (const [t, h] of prevHoldings) {
      const px = priceAt.get(t);
      if (px === undefined) {
        skippedPrices++;
        continue;
      }
      cfBook += h.shares * px;
    }
    if (cfBook <= 0) continue;
    fundsEvaluated++;

    // Per-fund active move per ticker → summed into its sector/subsector.
    const fundSector = new Map<string, { delta: number; dollar: number }>();
    const fundSub = new Map<string, { delta: number; dollar: number }>();
    const tickers = new Set([...prevHoldings.keys(), ...curHoldings.keys()]);
    for (const t of tickers) {
      const curV = curHoldings.get(t)?.value ?? 0;
      const prevShares = prevHoldings.get(t)?.shares ?? 0;
      const px = priceAt.get(t);
      const cfV = prevShares > 0 && px !== undefined ? prevShares * px : 0;
      const deltaBps = (curV / book - cfV / cfBook) * 10000;
      const dollar = curV - cfV;

      // Name-level: averaged over participating funds only.
      const na = bump(nameAcc, t);
      na.sumDelta += deltaBps;
      na.dollar += dollar;
      na.participating += 1;
      if (deltaBps > ACTIVE_FLOW_EPS_BPS) na.fundsIn += 1;
      else if (deltaBps < -ACTIVE_FLOW_EPS_BPS) na.fundsOut += 1;

      const m = meta.get(t);
      if (m?.sector) {
        const e = fundSector.get(m.sector) ?? { delta: 0, dollar: 0 };
        e.delta += deltaBps;
        e.dollar += dollar;
        fundSector.set(m.sector, e);
      }
      if (m?.subsector) {
        const e = fundSub.get(m.subsector) ?? { delta: 0, dollar: 0 };
        e.delta += deltaBps;
        e.dollar += dollar;
        fundSub.set(m.subsector, e);
      }
    }

    // Roll this fund's per-sector / per-subsector totals into the group accumulators.
    // Diffusion is counted on the fund's TOTAL move in the bucket, not per name.
    const rollGroup = (per: Map<string, { delta: number; dollar: number }>, prefix: string) => {
      for (const [key, { delta, dollar }] of per) {
        const a = bump(groupAcc, `${prefix}|${key}`);
        a.sumDelta += delta;
        a.dollar += dollar;
        a.participating += 1;
        if (delta > ACTIVE_FLOW_EPS_BPS) a.fundsIn += 1;
        else if (delta < -ACTIVE_FLOW_EPS_BPS) a.fundsOut += 1;
      }
    };
    rollGroup(fundSector, "SECTOR");
    rollGroup(fundSub, "SUBSECTOR");
  }

  // Finalize. Group averages divide by ALL evaluated funds (non-participants moved
  // 0 bps) — that is the "average tracked fund" the axis narrates, and it makes the
  // per-fund sum across sectors ≈ 0. Name averages divide by participating funds
  // (averaging a 5-holder name over ~140 books would be meaningless dust).
  const byName = new Map<string, ActiveFlowStat>();
  for (const [t, a] of nameAcc) {
    byName.set(t, {
      activeBpsAvg: round2(a.participating > 0 ? a.sumDelta / a.participating : 0),
      // Capital-flow ingredient: the same Σ deltaBps divided by ALL evaluated
      // funds (non-holders contributed 0), i.e. the leaderboard's netflow_bps.
      netBpsAllFunds: round2(fundsEvaluated > 0 ? a.sumDelta / fundsEvaluated : 0),
      fundsIn: a.fundsIn,
      fundsOut: a.fundsOut,
      fundsParticipating: a.participating,
      fundsEvaluated,
      dollarNetFlow: round2(a.dollar),
    });
  }
  const byGroup = new Map<string, ActiveFlowStat>();
  for (const [key, a] of groupAcc) {
    const avg = round2(fundsEvaluated > 0 ? a.sumDelta / fundsEvaluated : 0);
    byGroup.set(key, {
      activeBpsAvg: avg,
      netBpsAllFunds: avg,
      fundsIn: a.fundsIn,
      fundsOut: a.fundsOut,
      fundsParticipating: a.participating,
      fundsEvaluated,
      dollarNetFlow: round2(a.dollar),
    });
  }
  return { byName, byGroup, skippedPrices };
}

/**
 * Per-fund, per-ticker active vs expected weight (bps of the fund's tracked book)
 * for one adjacent quarter pair. Pure. This is the fund-level view of the same
 * math computeActiveFlowPair aggregates — used to precompute the leaderboard's
 * per-fund ingredients (activeWeightBps / expectedWeightBps → netBps).
 * Key: `${fundId}|${ticker}`. Only funds present in BOTH quarters with positive
 * actual and counterfactual books are evaluated (matches the diffusion fund set).
 */
export function computePerFundActiveWeights(
  prev: FundHoldingsByPeriod,
  cur: FundHoldingsByPeriod,
): Map<string, { activeWeightBps: number; expectedWeightBps: number }> {
  // Implied price per ticker at t: median(value/shares), fall back to t−1.
  const curPx = new Map<string, number[]>();
  const prevPx = new Map<string, number[]>();
  const collect = (src: FundHoldingsByPeriod, into: Map<string, number[]>) => {
    for (const holdings of src.values())
      for (const [t, h] of holdings) if (h.shares > 0) (into.get(t) ?? into.set(t, []).get(t)!).push(h.value / h.shares);
  };
  collect(cur, curPx);
  collect(prev, prevPx);
  const priceAt = new Map<string, number>();
  for (const t of new Set([...curPx.keys(), ...prevPx.keys()])) {
    const p = median(curPx.get(t) ?? []) ?? median(prevPx.get(t) ?? []);
    if (p !== null) priceAt.set(t, p);
  }

  const out = new Map<string, { activeWeightBps: number; expectedWeightBps: number }>();
  for (const [fundId, curHoldings] of cur) {
    const prevHoldings = prev.get(fundId);
    if (!prevHoldings) continue;
    const book = bookOf(curHoldings);
    if (book <= 0) continue;
    let cfBook = 0;
    for (const [t, h] of prevHoldings) {
      const px = priceAt.get(t);
      if (px !== undefined) cfBook += h.shares * px;
    }
    if (cfBook <= 0) continue;
    const tickers = new Set([...prevHoldings.keys(), ...curHoldings.keys()]);
    for (const t of tickers) {
      const curV = curHoldings.get(t)?.value ?? 0;
      const prevShares = prevHoldings.get(t)?.shares ?? 0;
      const px = priceAt.get(t);
      const cfV = prevShares > 0 && px !== undefined ? prevShares * px : 0;
      out.set(`${fundId}|${t}`, {
        activeWeightBps: round2((curV / book) * 10000),
        expectedWeightBps: round2((cfV / cfBook) * 10000),
      });
    }
  }
  return out;
}

/** Net diffusion % = (fundsIn − fundsOut) / participating × 100, signed −100..+100. */
export function netDiffusionPct(stat: { fundsIn: number; fundsOut: number; fundsParticipating: number }): number {
  if (stat.fundsParticipating <= 0) return 0;
  return round2(((stat.fundsIn - stat.fundsOut) / stat.fundsParticipating) * 100);
}

/** Load one quarter's non-diversified active-fund long-equity holdings. */
async function loadPeriod(period: string): Promise<FundHoldingsByPeriod> {
  const rows = await prisma.$queryRaw<Array<{ fundId: string; ticker: string; shares: number; value: number }>>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h.shares::float8 AS shares, h.value::float8 AS value
    FROM "FundHoldingSnapshot" h
    WHERE h."filingPeriod" = ${period}::date AND h.shares > 0 AND ${signalFundFilter("h")}`);
  const holdings: FundHoldingsByPeriod = new Map();
  for (const r of rows) {
    let m = holdings.get(r.fundId);
    if (!m) {
      m = new Map();
      holdings.set(r.fundId, m);
    }
    m.set(r.ticker, { shares: r.shares, value: r.value });
  }
  return holdings;
}

/**
 * Build active-flow stats for every adjacent quarter pair across `periods` (asc).
 * Keeps only two quarters of holdings in memory at once.
 * Returns maps keyed `${ticker}|${period}` and `${groupType}|${groupKey}|${period}`,
 * where `period` is the LATER quarter of the pair (the one the stat is reported for).
 */
export async function buildActiveFlowMetrics(
  periods: string[],
  meta: SectorMeta,
  log: (m: string) => void,
): Promise<{ byNamePeriod: Map<string, ActiveFlowStat>; byGroupPeriod: Map<string, ActiveFlowStat> }> {
  const byNamePeriod = new Map<string, ActiveFlowStat>();
  const byGroupPeriod = new Map<string, ActiveFlowStat>();
  let prev: FundHoldingsByPeriod | null = null;
  let totalSkipped = 0;

  for (const p of periods) {
    const cur = await loadPeriod(p);
    if (prev) {
      const { byName, byGroup, skippedPrices } = computeActiveFlowPair(prev, cur, meta);
      for (const [ticker, stat] of byName) byNamePeriod.set(`${ticker}|${p}`, stat);
      for (const [gk, stat] of byGroup) byGroupPeriod.set(`${gk}|${p}`, stat);
      totalSkipped += skippedPrices;
    }
    prev = cur;
  }
  log(`[institutional-agg] active-flow: ${byGroupPeriod.size} group-quarters, ${byNamePeriod.size} name-quarters` + (totalSkipped ? `, ${totalSkipped} price-less holdings skipped` : ""));
  return { byNamePeriod, byGroupPeriod };
}
