/**
 * Engine 2 — multi-box discovery scoring orchestrator (V1: 9 boxes).
 *
 * Reads each ticker's full trailing FundamentalPeriod history + latest snapshot
 * + estimate consensus (current and ~90d prior) + per-report earnings surprises
 * + trailing prices, assembles the flat `${box}.${component}` raw map per ticker
 * (box-inputs.ts), then runs the pure two-level peer z-scorer (box-scoring.ts):
 *   component -> z within peer group -> box score = mean(component z)
 *   composite = mean(available box scores), requiring >= MIN_VALID_BOXES boxes.
 *
 * Writes FundamentalScore (audited scoreJson + scoreMethodologyVersion) +
 * FundamentalSectorAggregate + DiscoveryQueueSnapshot. Deterministic and
 * idempotent: same stored inputs + methodology version => same scores.
 *
 * Residual momentum (Box 3) is the one cross-ticker signal: the equal-weight
 * subsector benchmark is assembled here (it needs peer membership + prices); the
 * window math lives in the pure residual-momentum lib.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { compounder, accrualsDivergence } from "@/lib/fundamental/quality";
import { valuationPercentiles } from "@/lib/fundamental/valuation";
import { buildMetricSeries, lastFinite, type PeriodFacts } from "@/lib/fundamental/series";
import { isNewArrival, rankAndDecile } from "@/lib/revision/scoring";
import { resolvePeerGroups, rollupGroups, type RefClassification } from "@/lib/revision/aggregate";
import {
  SCORE_METHODOLOGY_VERSION,
  BOX_REGISTRY,
  flatKey,
  type BoxKey,
} from "@/lib/fundamental/boxes";
import { computeBoxScores, type TickerBoxResult } from "@/lib/fundamental/box-scoring";
import { buildBoxComponents, type BoxInputBundle } from "@/lib/fundamental/box-inputs";
import { buildComponentSeries } from "@/lib/fundamental/component-series";
import {
  trailingWindowReturn,
  returnBetween,
  residual,
  MOM_WINDOW_START_BACK,
  MOM_WINDOW_END_BACK,
} from "@/lib/fundamental/residual-momentum";
import {
  dispersion,
  type EstimateTriple as ForecastTriple,
} from "@/lib/fundamental/forecast-confidence";
import { surpriseRatio, EPS_DENOM_FLOOR } from "@/lib/fundamental/surprise";
import { computeFlags } from "@/lib/fundamental/flags";

export interface FundamentalScoreOptions {
  snapshotDate?: string;
  log?: (msg: string) => void;
}

export interface FundamentalScoreSummary {
  snapshotDate: string;
  priorSnapshotDate: string | null;
  scored: number;
  newArrivals: number;
  traps: number;
  sectorGroups: number;
  subsectorGroups: number;
  methodologyVersion: string;
}

type PeriodRow = Prisma.FundamentalPeriodGetPayload<Record<string, never>>;
type SnapshotRow = Prisma.FundamentalSnapshotGetPayload<Record<string, never>>;

const PRICE_LOOKBACK_DAYS = 400; // covers 6-1m (~126 td) + since-last-earnings
const DISPERSION_PRIOR_MIN_LAG_DAYS = 84; // ~12 weeks for the 90d dispersion change
// Point-in-time box-z sparkline depth + the wider price window its historical
// residual-momentum reconstruction needs (6-1m window stepped back 8 quarters).
const HISTORY_QUARTERS = 8;
const HISTORY_PRICE_LOOKBACK_DAYS = PRICE_LOOKBACK_DAYS + HISTORY_QUARTERS * 92;

function dec(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function rowToFacts(p: PeriodRow): PeriodFacts {
  return {
    fiscalDate: isoOf(p.fiscalDate),
    revenue: dec(p.revenue),
    grossProfit: dec(p.grossProfit),
    operatingIncome: dec(p.operatingIncome),
    netIncome: dec(p.netIncome),
    ebitda: dec(p.ebitda),
    freeCashFlow: dec(p.freeCashFlow),
    operatingCashFlow: dec(p.operatingCashFlow),
    totalDebt: dec(p.totalDebt),
    cash: dec(p.cash),
    totalAssets: dec(p.totalAssets),
    roic: p.roic,
    peRatio: p.peRatio,
    evToEbitda: p.evToEbitda,
    priceToSales: p.priceToSales,
  };
}

/** Sum the last 4 quarterly values of a field; null if fewer than 4 or any null. */
function ttm4(rows: PeriodRow[], pick: (r: PeriodRow) => number | null): number | null {
  if (rows.length < 4) return null;
  const last4 = rows.slice(-4);
  let s = 0;
  for (const r of last4) {
    const v = pick(r);
    if (v === null || !Number.isFinite(v)) return null;
    s += v;
  }
  return s;
}

/** Average of the finite field values over the last 4 quarters (or null). */
function avg4(rows: PeriodRow[], pick: (r: PeriodRow) => number | null): number | null {
  const vals = rows
    .slice(-4)
    .map(pick)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** The nearest forward annual estimate period at/after `asOf` (fallback: latest). */
function pickForwardAnnual(estimatesJson: unknown, asOf: string): {
  eps: ForecastTriple | null;
  revenue: ForecastTriple | null;
  ebitda: ForecastTriple | null;
  numAnalystsEps: number | null;
  numAnalystsRevenue: number | null;
} | null {
  if (!estimatesJson || typeof estimatesJson !== "object") return null;
  const annual = (estimatesJson as { annual?: unknown }).annual;
  if (!Array.isArray(annual) || annual.length === 0) return null;
  const periods = annual as Array<Record<string, unknown>>;
  const fwd =
    periods.find((p) => typeof p.fiscalDate === "string" && (p.fiscalDate as string) >= asOf) ??
    periods[periods.length - 1]!;
  const triple = (v: unknown): ForecastTriple | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    return {
      low: typeof o.low === "number" ? o.low : null,
      avg: typeof o.avg === "number" ? o.avg : null,
      high: typeof o.high === "number" ? o.high : null,
    };
  };
  return {
    eps: triple(fwd.eps),
    revenue: triple(fwd.revenue),
    ebitda: triple(fwd.ebitda),
    numAnalystsEps: typeof fwd.numAnalystsEps === "number" ? fwd.numAnalystsEps : null,
    numAnalystsRevenue: typeof fwd.numAnalystsRevenue === "number" ? fwd.numAnalystsRevenue : null,
  };
}

function decilesWithinGroups(
  composites: Array<number | null>,
  groupKeys: string[],
): Array<number | null> {
  const out: Array<number | null> = new Array(composites.length).fill(null);
  const byGroup = new Map<string, number[]>();
  groupKeys.forEach((k, i) => {
    const arr = byGroup.get(k);
    if (arr) arr.push(i);
    else byGroup.set(k, [i]);
  });
  for (const idxs of byGroup.values()) {
    const sub = idxs.map((i) => composites[i] ?? null);
    for (const e of rankAndDecile(sub)) out[idxs[e.index]!] = e.decile;
  }
  return out;
}

function meanFinite(vals: Array<number | null>): number | null {
  const f = vals.filter((v): v is number => v !== null && Number.isFinite(v));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

interface PriceSeries {
  dates: string[];
  closes: number[];
}

/** Per-ticker legacy display signals kept for the current UI until the grid is generalized. */
interface LegacyDisplay {
  inflection: Record<string, number | null>;
  compounderScore: number | null;
  compounderLevel: number | null;
  compounderConsistency: number | null;
  accrualsDivergence: number | null;
  accrualsRatio: number | null;
  cheapness: number | null;
  valuationDetail: { peRatio: number | null; evToEbitda: number | null; priceToSales: number | null };
  marginNow: number | null;
  marginPrior: number | null;
  series: {
    grossMargin: number[];
    ebitdaMargin: number[];
    revenueGrowth: number[];
    fcf: number[];
    roic: number[];
    netDebtToEbitda: number[];
  };
}

function last8Finite(series: Array<number | null>, n = 8): number[] {
  return series.filter((v): v is number => v !== null && Number.isFinite(v)).slice(-n);
}
function finiteBack(series: Array<number | null>, back = 8): number | null {
  const idxs: number[] = [];
  series.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) idxs.push(i);
  });
  if (idxs.length === 0) return null;
  return series[idxs[Math.max(0, idxs.length - 1 - back)]!] ?? null;
}

export async function scoreFundamentalBoxesWeek(
  opts: FundamentalScoreOptions = {},
): Promise<FundamentalScoreSummary> {
  const log = opts.log ?? (() => {});
  const emptySummary = (snapshotDate: string): FundamentalScoreSummary => ({
    snapshotDate,
    priorSnapshotDate: null,
    scored: 0,
    newArrivals: 0,
    traps: 0,
    sectorGroups: 0,
    subsectorGroups: 0,
    methodologyVersion: SCORE_METHODOLOGY_VERSION,
  });

  const latest = opts.snapshotDate
    ? new Date(`${opts.snapshotDate}T00:00:00Z`)
    : (
        await prisma.fundamentalSnapshot.findFirst({
          orderBy: { snapshotDate: "desc" },
          select: { snapshotDate: true },
        })
      )?.snapshotDate ?? null;
  if (!latest) {
    log("[fund-box] no snapshots present");
    return emptySummary("");
  }
  const snapshotIso = isoOf(latest);

  const snapshots = await prisma.fundamentalSnapshot.findMany({ where: { snapshotDate: latest } });
  const snapByTicker = new Map<string, SnapshotRow>(snapshots.map((s) => [s.ticker, s]));
  const tickers = snapshots.map((s) => s.ticker);
  if (tickers.length === 0) {
    log("[fund-box] snapshot date has no rows");
    return emptySummary(snapshotIso);
  }

  // ── Bulk loads (one query each; no per-ticker FMP calls in scoring) ──────
  const [periodRows, refs, securities, earnings] = await Promise.all([
    prisma.fundamentalPeriod.findMany({
      where: { ticker: { in: tickers }, periodType: "quarter" },
      orderBy: [{ ticker: "asc" }, { fiscalDate: "asc" }],
    }),
    prisma.revisionReference.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, sector: true, subsector: true, companyName: true },
    }),
    prisma.security.findMany({
      where: { ticker: { in: tickers } },
      select: { id: true, ticker: true },
    }),
    prisma.earningsSurprise.findMany({
      where: { ticker: { in: tickers }, reportDate: { lte: latest } },
      orderBy: [{ ticker: "asc" }, { reportDate: "asc" }],
    }),
  ]);

  const periodsByTicker = new Map<string, PeriodRow[]>();
  for (const r of periodRows) {
    const arr = periodsByTicker.get(r.ticker) ?? [];
    arr.push(r);
    periodsByTicker.set(r.ticker, arr);
  }
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));
  const earningsByTicker = new Map<string, typeof earnings>();
  for (const e of earnings) {
    const arr = earningsByTicker.get(e.ticker) ?? [];
    arr.push(e);
    earningsByTicker.set(e.ticker, arr);
  }

  // Estimate consensus: latest revision week + a ~90d-prior week (dispersion change).
  const maxRev = await prisma.revisionSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const latestRevByTicker = new Map<string, { estimatesJson: unknown }>();
  const priorRevByTicker = new Map<string, { estimatesJson: unknown }>();
  if (maxRev) {
    const latestRev = await prisma.revisionSnapshot.findMany({
      where: { ticker: { in: tickers }, snapshotDate: maxRev.snapshotDate },
      select: { ticker: true, estimatesJson: true },
    });
    for (const r of latestRev) latestRevByTicker.set(r.ticker, { estimatesJson: r.estimatesJson });
    const priorCutoff = new Date(maxRev.snapshotDate);
    priorCutoff.setUTCDate(priorCutoff.getUTCDate() - DISPERSION_PRIOR_MIN_LAG_DAYS);
    const priorRevDate = await prisma.revisionSnapshot.findFirst({
      where: { snapshotDate: { lte: priorCutoff } },
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true },
    });
    if (priorRevDate) {
      const priorRev = await prisma.revisionSnapshot.findMany({
        where: { ticker: { in: tickers }, snapshotDate: priorRevDate.snapshotDate },
        select: { ticker: true, estimatesJson: true },
      });
      for (const r of priorRev) priorRevByTicker.set(r.ticker, { estimatesJson: r.estimatesJson });
    }
  }

  // Trailing prices for residual momentum, keyed by ticker (ascending).
  const secIdToTicker = new Map(securities.map((s) => [s.id, s.ticker]));
  const priceCutoff = new Date(latest);
  priceCutoff.setUTCDate(priceCutoff.getUTCDate() - HISTORY_PRICE_LOOKBACK_DAYS);
  const priceRows = securities.length
    ? await prisma.priceHistory.findMany({
        where: { securityId: { in: securities.map((s) => s.id) }, tradeDate: { gte: priceCutoff, lte: latest } },
        orderBy: [{ securityId: "asc" }, { tradeDate: "asc" }],
        select: { securityId: true, tradeDate: true, adjClose: true },
      })
    : [];
  const priceByTicker = new Map<string, PriceSeries>();
  for (const p of priceRows) {
    const ticker = secIdToTicker.get(p.securityId);
    if (!ticker) continue;
    const ps = priceByTicker.get(ticker) ?? { dates: [], closes: [] };
    ps.dates.push(isoOf(p.tradeDate));
    ps.closes.push(Number(p.adjClose));
    priceByTicker.set(ticker, ps);
  }

  // ── Peer groups (subsector-first, sector fallback) — Engine 1 convention ──
  const classifications: RefClassification[] = tickers.map((ticker) => ({
    ticker,
    sector: refByTicker.get(ticker)?.sector ?? null,
    subsector: refByTicker.get(ticker)?.subsector ?? null,
  }));
  const peers = resolvePeerGroups(classifications);
  const peerKeys = tickers.map((t) => peers.get(t)!.peerGroupKey);

  // ── Residual momentum: stock returns, then equal-weight peer benchmark ────
  const lastEarningsIso = new Map<string, string | null>();
  const stock6m1m = new Map<string, number | null>();
  const stockSinceEarn = new Map<string, number | null>();
  for (const t of tickers) {
    const ps = priceByTicker.get(t);
    const er = earningsByTicker.get(t);
    const earnIso = er && er.length ? isoOf(er[er.length - 1]!.reportDate) : null;
    lastEarningsIso.set(t, earnIso);
    if (!ps) {
      stock6m1m.set(t, null);
      stockSinceEarn.set(t, null);
      continue;
    }
    stock6m1m.set(t, trailingWindowReturn(ps.closes, MOM_WINDOW_START_BACK, MOM_WINDOW_END_BACK));
    stockSinceEarn.set(t, earnIso ? returnBetween(ps.dates, ps.closes, earnIso) : null);
  }
  // Peer-group membership for benchmark averaging.
  const peerMembers = new Map<string, string[]>();
  tickers.forEach((t, i) => {
    const k = peerKeys[i]!;
    const arr = peerMembers.get(k) ?? [];
    arr.push(t);
    peerMembers.set(k, arr);
  });
  const residual6m1m = new Map<string, number | null>();
  const residualSinceEarn = new Map<string, number | null>();
  tickers.forEach((t, i) => {
    const members = peerMembers.get(peerKeys[i]!) ?? [];
    const bench6 = meanFinite(members.map((m) => stock6m1m.get(m) ?? null));
    residual6m1m.set(t, residual(stock6m1m.get(t) ?? null, bench6));
    const earnIso = lastEarningsIso.get(t) ?? null;
    if (earnIso) {
      const benchSince = meanFinite(
        members.map((m) => {
          const mp = priceByTicker.get(m);
          return mp ? returnBetween(mp.dates, mp.closes, earnIso) : null;
        }),
      );
      residualSinceEarn.set(t, residual(stockSinceEarn.get(t) ?? null, benchSince));
    } else {
      residualSinceEarn.set(t, null);
    }
  });

  // ── Per-ticker bundle assembly ────────────────────────────────────────────
  interface PerTicker {
    bundle: BoxInputBundle;
    components: Record<string, number | null>;
    componentSeries: Record<string, number[]>;
    legacy: LegacyDisplay;
    extras: {
      rawDilutedYoy: number | null;
      rawEpsDispersion: number | null;
      daysSinceLatestFiscal: number | null;
      fcfTtm: number | null;
      ebitdaTtm: number | null;
      netDebtToEbitda: number | null;
      totalEquity: number | null;
      marketCap: number | null;
      analystCount: number | null;
      trap: boolean;
    };
  }
  const perTicker: PerTicker[] = tickers.map((ticker) => {
    const rows = periodsByTicker.get(ticker) ?? [];
    const facts = rows.map(rowToFacts);
    const series = buildMetricSeries(facts);
    const snap = snapByTicker.get(ticker);
    const latestRow = rows.at(-1) ?? null;

    const ttm = {
      ebitda: ttm4(rows, (r) => dec(r.ebitda)),
      interestExpense: ttm4(rows, (r) => dec(r.interestExpense)),
      cfo: ttm4(rows, (r) => dec(r.operatingCashFlow)),
      capex: ttm4(rows, (r) => dec(r.capex)),
      netIncome: ttm4(rows, (r) => dec(r.netIncome)),
      sbc: ttm4(rows, (r) => dec(r.stockBasedCompensation)),
      changeInWorkingCapital: ttm4(rows, (r) => dec(r.changeInWorkingCapital)),
      commonStockIssued: ttm4(rows, (r) => dec(r.commonStockIssued)),
      commonStockRepurchased: ttm4(rows, (r) => dec(r.commonStockRepurchased)),
      revenue: ttm4(rows, (r) => dec(r.revenue)),
      fcf: ttm4(rows, (r) => dec(r.freeCashFlow)),
    };
    const avgTotalAssets = avg4(rows, (r) => dec(r.totalAssets));
    const marketCap = dec(snap?.marketCap ?? null);

    const fwd = latestRevByTicker.get(ticker)
      ? pickForwardAnnual(latestRevByTicker.get(ticker)!.estimatesJson, snapshotIso)
      : null;
    const priorFwd = priorRevByTicker.get(ticker)
      ? pickForwardAnnual(priorRevByTicker.get(ticker)!.estimatesJson, snapshotIso)
      : null;
    const priorEpsDispersion = priorFwd ? dispersion(priorFwd.eps) : null;

    const epsReports = (earningsByTicker.get(ticker) ?? []).map((e) => ({
      actual: dec(e.epsActual),
      expected: dec(e.epsEstimated),
    }));
    const revReports = (earningsByTicker.get(ticker) ?? []).map((e) => ({
      actual: dec(e.revenueActual),
      expected: dec(e.revenueEstimated),
    }));
    const epsSurpriseHistory = epsReports
      .map((r) => surpriseRatio(r.actual, r.expected, EPS_DENOM_FLOOR))
      .filter((v): v is number => v !== null);

    const bundle: BoxInputBundle = {
      series,
      ttm: { ...ttm },
      current: {
        netDebtToEbitda: snap?.netDebtToEbitda ?? null,
        cash: dec(latestRow?.cash ?? null),
        totalDebt: dec(latestRow?.totalDebt ?? null),
        totalEquity: dec(latestRow?.totalEquity ?? null),
        evToEbitda: dec(snap?.evToEbitda ?? null),
        peRatio: dec(snap?.peRatio ?? null),
        fcfYield: latestRow?.fcfYield ?? null,
        dividendYield: latestRow?.dividendYield ?? null,
        marketCap,
      },
      dilutedShares: rows.map((r) => dec(r.sharesDiluted)),
      avgTotalAssets,
      surprises: { eps: epsReports, revenue: revReports },
      residual: {
        residual6m1m: residual6m1m.get(ticker) ?? null,
        residualSinceEarnings: residualSinceEarn.get(ticker) ?? null,
      },
      forecast: {
        eps: fwd?.eps ?? null,
        revenue: fwd?.revenue ?? null,
        ebitda: fwd?.ebitda ?? null,
        priorEpsDispersion,
        numAnalystsEps: fwd?.numAnalystsEps ?? null,
        numAnalystsRevenue: fwd?.numAnalystsRevenue ?? null,
        epsSurpriseHistory,
      },
    };

    // Legacy display signals (kept for the current grid until M5 generalizes it).
    const comp = compounder(series.roic);
    const divergence = accrualsDivergence(series.netIncome, series.operatingCashFlow);
    const val = valuationPercentiles(
      {
        peRatio: dec(snap?.peRatio ?? null),
        evToEbitda: dec(snap?.evToEbitda ?? null),
        priceToSales: dec(snap?.priceToSales ?? null),
      },
      { peRatio: series.peRatio, evToEbitda: series.evToEbitda, priceToSales: series.priceToSales },
    );
    const components = buildBoxComponents(bundle);
    const componentSeries = buildComponentSeries({
      metric: series,
      ebitda: rows.map((r) => dec(r.ebitda)),
      operatingCashFlow: rows.map((r) => dec(r.operatingCashFlow)),
      netIncome: rows.map((r) => dec(r.netIncome)),
      totalAssets: rows.map((r) => dec(r.totalAssets)),
      changeInWorkingCapital: rows.map((r) => dec(r.changeInWorkingCapital)),
      interestExpense: rows.map((r) => dec(r.interestExpense)),
      stockBasedCompensation: rows.map((r) => dec(r.stockBasedCompensation)),
      revenue: rows.map((r) => dec(r.revenue)),
      cash: rows.map((r) => dec(r.cash)),
      totalDebt: rows.map((r) => dec(r.totalDebt)),
      commonStockIssued: rows.map((r) => dec(r.commonStockIssued)),
      commonStockRepurchased: rows.map((r) => dec(r.commonStockRepurchased)),
      dilutedShares: rows.map((r) => dec(r.sharesDiluted)),
      fcfYield: rows.map((r) => r.fcfYield),
      dividendYield: rows.map((r) => r.dividendYield),
      epsSurprises: epsReports,
      revenueSurprises: revReports,
    });
    const inflection: Record<string, number | null> = {};
    for (const c of BOX_REGISTRY[0]!.components) {
      inflection[c.key] = components[flatKey("inflection", c.key)] ?? null;
    }

    let daysSinceLatestFiscal: number | null = null;
    if (latestRow) {
      daysSinceLatestFiscal = Math.round(
        (latest.getTime() - latestRow.fiscalDate.getTime()) / 86_400_000,
      );
    }
    const now = lastFinite(bundle.dilutedShares);
    const yearAgo = finiteBack(bundle.dilutedShares, 4);
    const rawDilutedYoy =
      now !== null && yearAgo !== null && Math.abs(yearAgo) > 1e-9 ? now / yearAgo - 1 : null;

    return {
      bundle,
      components,
      componentSeries,
      legacy: {
        inflection,
        compounderScore: comp.score,
        compounderLevel: comp.level,
        compounderConsistency: comp.consistency,
        accrualsDivergence: divergence,
        accrualsRatio: snap?.accrualsRatio ?? null,
        cheapness: val.cheapness,
        valuationDetail: { peRatio: val.peRatio, evToEbitda: val.evToEbitda, priceToSales: val.priceToSales },
        marginNow: lastFinite(series.ttmEbitdaMargin),
        marginPrior: finiteBack(series.ttmEbitdaMargin, 8),
        series: {
          grossMargin: last8Finite(series.ttmGrossMargin),
          ebitdaMargin: last8Finite(series.ttmEbitdaMargin),
          revenueGrowth: last8Finite(series.revenueGrowthYoy),
          fcf: last8Finite(series.ttmFcf),
          roic: last8Finite(series.roic),
          netDebtToEbitda: last8Finite(series.netDebtToEbitda),
        },
      },
      extras: {
        rawDilutedYoy,
        rawEpsDispersion: fwd ? dispersion(fwd.eps) : null,
        daysSinceLatestFiscal,
        fcfTtm: ttm.fcf,
        ebitdaTtm: ttm.ebitda,
        netDebtToEbitda: snap?.netDebtToEbitda ?? null,
        totalEquity: dec(latestRow?.totalEquity ?? null),
        marketCap,
        analystCount:
          fwd && (fwd.numAnalystsEps !== null || fwd.numAnalystsRevenue !== null)
            ? Math.max(fwd.numAnalystsEps ?? 0, fwd.numAnalystsRevenue ?? 0)
            : null,
        trap: false, // set after divergence; see below
      },
    };
  });

  // Trap flag (legacy quality kill-switch) — accruals ratio or divergence.
  perTicker.forEach((p) => {
    const ratioBad = p.legacy.accrualsRatio !== null && p.legacy.accrualsRatio > 0.1;
    const divBad = p.legacy.accrualsDivergence !== null && p.legacy.accrualsDivergence > 0.15;
    p.extras.trap = ratioBad || divBad;
  });

  // ── Two-level box scoring ─────────────────────────────────────────────────
  const componentMaps = perTicker.map((p) => p.components);
  const boxResults: TickerBoxResult[] = computeBoxScores({ components: componentMaps, peerKeys });

  // ── Point-in-time box-z reconstruction (last HISTORY_QUARTERS quarters) ────
  // A box score is a peer-relative cross-section, so each historical point
  // re-runs the two-level scorer over the whole universe using only data known
  // as-of that quarter. Restated-basis (display-only) — see schema notes; peer
  // grouping uses today's taxonomy. The newest point is overwritten with the
  // live box score so the sparkline's right edge ties to the grid bar exactly.
  // Forecast Confidence has no estimate history, so its historical points are
  // null (its sparkline accrues forward from launch).
  const asOfDates: Date[] = [];
  for (let k = HISTORY_QUARTERS - 1; k >= 0; k--) {
    const d = new Date(latest);
    d.setUTCMonth(d.getUTCMonth() - 3 * k);
    asOfDates.push(d);
  }
  const boxHistory: Array<Partial<Record<BoxKey, Array<number | null>>>> = tickers.map(
    () =>
      Object.fromEntries(
        BOX_REGISTRY.map((b) => [b.key, [] as Array<number | null>]),
      ) as Partial<Record<BoxKey, Array<number | null>>>,
  );

  for (const asOf of asOfDates) {
    const asOfIso = isoOf(asOf);

    // Truncate each ticker's price series to bars on/before asOf (dates asc).
    const truncated = new Map<string, PriceSeries>();
    for (const t of tickers) {
      const ps = priceByTicker.get(t);
      if (!ps) {
        truncated.set(t, { dates: [], closes: [] });
        continue;
      }
      const dts: string[] = [];
      const cls: number[] = [];
      for (let j = 0; j < ps.dates.length; j++) {
        if (ps.dates[j]! <= asOfIso) {
          dts.push(ps.dates[j]!);
          cls.push(ps.closes[j]!);
        } else break;
      }
      truncated.set(t, { dates: dts, closes: cls });
    }

    // Stock returns + last earnings as-of asOf, then equal-weight peer residual.
    const s6 = new Map<string, number | null>();
    const sSince = new Map<string, number | null>();
    const earnAsOf = new Map<string, string | null>();
    for (const t of tickers) {
      const tr = truncated.get(t)!;
      const er = (earningsByTicker.get(t) ?? []).filter((e) => isoOf(e.reportDate) <= asOfIso);
      const eIso = er.length ? isoOf(er[er.length - 1]!.reportDate) : null;
      earnAsOf.set(t, eIso);
      if (!tr.closes.length) {
        s6.set(t, null);
        sSince.set(t, null);
        continue;
      }
      s6.set(t, trailingWindowReturn(tr.closes, MOM_WINDOW_START_BACK, MOM_WINDOW_END_BACK));
      sSince.set(t, eIso ? returnBetween(tr.dates, tr.closes, eIso) : null);
    }
    const r6 = new Map<string, number | null>();
    const rSince = new Map<string, number | null>();
    tickers.forEach((t, i) => {
      const members = peerMembers.get(peerKeys[i]!) ?? [];
      r6.set(t, residual(s6.get(t) ?? null, meanFinite(members.map((m) => s6.get(m) ?? null))));
      const eIso = earnAsOf.get(t) ?? null;
      if (eIso) {
        const benchSince = meanFinite(
          members.map((m) => {
            const mt = truncated.get(m);
            return mt && mt.closes.length ? returnBetween(mt.dates, mt.closes, eIso) : null;
          }),
        );
        rSince.set(t, residual(sSince.get(t) ?? null, benchSince));
      } else rSince.set(t, null);
    });

    // Assemble each ticker's as-of component map and score the cross-section.
    const componentMapsAsOf = tickers.map((ticker) => {
      const allRows = periodsByTicker.get(ticker) ?? [];
      const rows = allRows.filter((r) => isoOf(r.fiscalDate) <= asOfIso);
      if (rows.length === 0) return {} as Record<string, number | null>;
      const facts = rows.map(rowToFacts);
      const series = buildMetricSeries(facts);
      const latestRow = rows[rows.length - 1]!;
      const tr = truncated.get(ticker);
      const closeAsOf = tr && tr.closes.length ? tr.closes[tr.closes.length - 1]! : null;
      const sharesAsOf = lastFinite(rows.map((r) => dec(r.sharesDiluted)));
      const marketCapAsOf =
        sharesAsOf !== null && closeAsOf !== null ? sharesAsOf * closeAsOf : null;
      const epsReports = (earningsByTicker.get(ticker) ?? [])
        .filter((e) => isoOf(e.reportDate) <= asOfIso)
        .map((e) => ({ actual: dec(e.epsActual), expected: dec(e.epsEstimated) }));
      const revReports = (earningsByTicker.get(ticker) ?? [])
        .filter((e) => isoOf(e.reportDate) <= asOfIso)
        .map((e) => ({ actual: dec(e.revenueActual), expected: dec(e.revenueEstimated) }));
      const bundle: BoxInputBundle = {
        series,
        ttm: {
          ebitda: ttm4(rows, (r) => dec(r.ebitda)),
          interestExpense: ttm4(rows, (r) => dec(r.interestExpense)),
          cfo: ttm4(rows, (r) => dec(r.operatingCashFlow)),
          capex: ttm4(rows, (r) => dec(r.capex)),
          netIncome: ttm4(rows, (r) => dec(r.netIncome)),
          sbc: ttm4(rows, (r) => dec(r.stockBasedCompensation)),
          changeInWorkingCapital: ttm4(rows, (r) => dec(r.changeInWorkingCapital)),
          commonStockIssued: ttm4(rows, (r) => dec(r.commonStockIssued)),
          commonStockRepurchased: ttm4(rows, (r) => dec(r.commonStockRepurchased)),
          revenue: ttm4(rows, (r) => dec(r.revenue)),
          fcf: ttm4(rows, (r) => dec(r.freeCashFlow)),
        },
        current: {
          netDebtToEbitda: latestRow.netDebtToEbitda ?? null,
          cash: dec(latestRow.cash),
          totalDebt: dec(latestRow.totalDebt),
          totalEquity: dec(latestRow.totalEquity),
          evToEbitda: latestRow.evToEbitda ?? null,
          peRatio: latestRow.peRatio ?? null,
          fcfYield: latestRow.fcfYield ?? null,
          dividendYield: latestRow.dividendYield ?? null,
          marketCap: marketCapAsOf,
        },
        dilutedShares: rows.map((r) => dec(r.sharesDiluted)),
        avgTotalAssets: avg4(rows, (r) => dec(r.totalAssets)),
        surprises: { eps: epsReports, revenue: revReports },
        residual: {
          residual6m1m: r6.get(ticker) ?? null,
          residualSinceEarnings: rSince.get(ticker) ?? null,
        },
        forecast: {
          eps: null,
          revenue: null,
          ebitda: null,
          priorEpsDispersion: null,
          numAnalystsEps: null,
          numAnalystsRevenue: null,
          epsSurpriseHistory: epsReports
            .map((r) => surpriseRatio(r.actual, r.expected, EPS_DENOM_FLOOR))
            .filter((v): v is number => v !== null),
        },
      };
      return buildBoxComponents(bundle);
    });

    const asOfResults = computeBoxScores({ components: componentMapsAsOf, peerKeys });
    asOfResults.forEach((res, i) => {
      for (const b of BOX_REGISTRY) boxHistory[i]![b.key]!.push(res.boxScores[b.key] ?? null);
    });
  }

  // Anchor the newest point to the live box score so the spark ties to the bar.
  boxResults.forEach((res, i) => {
    for (const b of BOX_REGISTRY) {
      const arr = boxHistory[i]![b.key]!;
      if (arr.length) arr[arr.length - 1] = res.boxScores[b.key] ?? null;
    }
  });

  const composites = boxResults.map((r) => r.composite);
  const ranked = rankAndDecile(composites);
  const globalRank = new Map<number, number>();
  for (const e of ranked) globalRank.set(e.index, e.rank);
  const sectorKeys = classifications.map((c) => c.sector ?? "Unclassified");
  const subsectorKeys = classifications.map((c) => c.subsector ?? c.sector ?? "Unclassified");
  const sectorDeciles = decilesWithinGroups(composites, sectorKeys);
  const subsectorDeciles = decilesWithinGroups(composites, subsectorKeys);

  // Prior-week deciles for new-arrival detection.
  const priorDateRow = await prisma.fundamentalScore.findFirst({
    where: { snapshotDate: { lt: latest } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const priorDate = priorDateRow?.snapshotDate ?? null;
  const priorScores = priorDate
    ? await prisma.fundamentalScore.findMany({
        where: { snapshotDate: priorDate },
        select: { ticker: true, subsectorDecile: true, sectorDecile: true },
      })
    : [];
  const priorDecileByTicker = new Map(
    priorScores.map((p) => [p.ticker, p.subsectorDecile ?? p.sectorDecile ?? null]),
  );

  let scored = 0;
  let newArrivals = 0;
  let traps = 0;
  const queueRows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]!;
    const peer = peers.get(ticker)!;
    const box = boxResults[i]!;
    const pt = perTicker[i]!;
    const composite = composites[i] ?? null;
    const subDecile = subsectorDeciles[i] ?? null;
    const secDecile = sectorDeciles[i] ?? null;
    const primaryDecile = peer.peerGroupType === "SUBSECTOR" ? subDecile : secDecile;
    const newArrival = isNewArrival(primaryDecile, priorDecileByTicker.get(ticker) ?? null);
    if (newArrival) newArrivals++;
    if (pt.extras.trap) traps++;

    const compZ = box.componentZ;
    const flags = computeFlags({
      netDebtToEbitda: pt.extras.netDebtToEbitda,
      fcfTtm: pt.extras.fcfTtm,
      interestCoverage: componentMaps[i]![flatKey("balanceSheet", "interestCoverage")] ?? null,
      dilutedShareGrowthYoy: pt.extras.rawDilutedYoy,
      analystCount: pt.extras.analystCount,
      epsDispersion: pt.extras.rawEpsDispersion,
      residual6m1m: componentMaps[i]![flatKey("residualMomentum", "residual6m1m")] ?? null,
      workingCapitalQuality: componentMaps[i]![flatKey("cashQuality", "workingCapitalQuality")] ?? null,
      persistenceBreadth: componentMaps[i]![flatKey("persistence", "persistenceBreadth")] ?? null,
      ebitdaMarginInflection: componentMaps[i]![flatKey("inflection", "ebitdaMarginInflection")] ?? null,
      ebitdaTtm: pt.extras.ebitdaTtm,
      totalEquity: pt.extras.totalEquity,
      marketCap: pt.extras.marketCap,
      daysSinceLatestFiscal: pt.extras.daysSinceLatestFiscal,
      sector: refByTicker.get(ticker)?.sector ?? null,
      validBoxCount: box.validBoxCount,
    });

    const ref = refByTicker.get(ticker);
    const scoreJson = {
      scoreMethodologyVersion: SCORE_METHODOLOGY_VERSION,
      composite,
      validBoxCount: box.validBoxCount,
      boxScores: box.boxScores,
      boxes: box.boxes,
      flags,
      peerGroup: peer,
      // Legacy display fields for the current grid (retired in M5).
      inflection: pt.legacy.inflection,
      z: Object.fromEntries(
        BOX_REGISTRY[0]!.components.map((c) => [c.key, compZ[flatKey("inflection", c.key)] ?? null]),
      ),
      series: pt.legacy.series,
      compounder: {
        score: pt.legacy.compounderScore,
        level: pt.legacy.compounderLevel,
        consistency: pt.legacy.compounderConsistency,
      },
      accruals: { ratio: pt.legacy.accrualsRatio, divergence: pt.legacy.accrualsDivergence },
      valuation: { cheapness: pt.legacy.cheapness, ...pt.legacy.valuationDetail },
    } as unknown as Prisma.InputJsonValue;

    try {
      const data = {
        peerGroupType: peer.peerGroupType,
        peerGroupKey: peer.peerGroupKey,
        composite,
        subsectorDecile: subDecile,
        sectorDecile: secDecile,
        rank: globalRank.get(i) ?? null,
        newArrival,
        trapFlag: pt.extras.trap,
        compounderScore: pt.legacy.compounderScore,
        valuationPercentile: pt.legacy.cheapness,
        scoreMethodologyVersion: SCORE_METHODOLOGY_VERSION,
        scoreJson,
      };
      await prisma.fundamentalScore.upsert({
        where: { ticker_snapshotDate: { ticker, snapshotDate: latest } },
        create: { ticker, snapshotDate: latest, ...data },
        update: data,
      });
      scored++;
    } catch (e) {
      log(`[fund-box] ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }

    queueRows.push({
      ticker,
      companyName: ref?.companyName ?? ticker,
      sector: ref?.sector ?? null,
      subsector: ref?.subsector ?? null,
      composite,
      validBoxCount: box.validBoxCount,
      rank: globalRank.get(i) ?? null,
      subsectorDecile: subDecile,
      sectorDecile: secDecile,
      newArrival,
      trapFlag: pt.extras.trap,
      flags,
      boxScores: box.boxScores,
      boxes: box.boxes,
      componentSeries: pt.componentSeries,
      boxScoreHistory: boxHistory[i],
      compounderScore: pt.legacy.compounderScore,
      compounderLevel: pt.legacy.compounderLevel,
      compounderConsistency: pt.legacy.compounderConsistency,
      cheapness: pt.legacy.cheapness,
      accrualsDivergence: pt.legacy.accrualsDivergence,
      marginNow: pt.legacy.marginNow,
      marginPrior: pt.legacy.marginPrior,
      inflection: pt.legacy.inflection,
      series: pt.legacy.series,
      z: Object.fromEntries(
        BOX_REGISTRY[0]!.components.map((c) => [c.key, compZ[flatKey("inflection", c.key)] ?? null]),
      ),
    });
  }
  queueRows.sort(
    (a, b) => ((b.composite as number) ?? -Infinity) - ((a.composite as number) ?? -Infinity),
  );

  // ── Sector / subsector aggregates (mean composite + margin-inflection breadth) ──
  const withScores = tickers.map((ticker, i) => ({
    ticker,
    composite: composites[i] ?? null,
    marginInflection: componentMaps[i]![flatKey("inflection", "ebitdaMarginInflection")] ?? null,
  }));
  const sectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.ticker)?.sector ?? "Unclassified",
    (s) => s.marginInflection,
    (s) => s.composite,
  );
  const subsectorRollups = rollupGroups(
    withScores,
    (s) => refByTicker.get(s.ticker)?.subsector ?? refByTicker.get(s.ticker)?.sector ?? "Unclassified",
    (s) => s.marginInflection,
    (s) => s.composite,
  );
  for (const [type, rollups] of [
    ["SECTOR", sectorRollups],
    ["SUBSECTOR", subsectorRollups],
  ] as const) {
    for (const g of rollups) {
      await prisma.fundamentalSectorAggregate.upsert({
        where: { groupType_groupKey_snapshotDate: { groupType: type, groupKey: g.groupKey, snapshotDate: latest } },
        create: {
          groupType: type,
          groupKey: g.groupKey,
          snapshotDate: latest,
          marginInflectionMean: g.breadth,
          compositeMean: g.compositeMean,
          nameCount: g.nameCount,
        },
        update: { marginInflectionMean: g.breadth, compositeMean: g.compositeMean, nameCount: g.nameCount },
      });
    }
  }

  const payloadJson = {
    snapshotDate: snapshotIso,
    generatedAt: new Date().toISOString(),
    scoreMethodologyVersion: SCORE_METHODOLOGY_VERSION,
    count: queueRows.length,
    rows: queueRows,
  } as unknown as Prisma.InputJsonValue;
  await prisma.discoveryQueueSnapshot.upsert({
    where: { snapshotDate: latest },
    create: { snapshotDate: latest, payloadJson },
    update: { payloadJson, computedAt: new Date() },
  });

  log(
    `[fund-box] scored ${scored}, new arrivals ${newArrivals}, traps ${traps}, sectors ${sectorRollups.length}, subsectors ${subsectorRollups.length} (${SCORE_METHODOLOGY_VERSION})`,
  );
  return {
    snapshotDate: snapshotIso,
    priorSnapshotDate: priorDate ? isoOf(priorDate) : null,
    scored,
    newArrivals,
    traps,
    sectorGroups: sectorRollups.length,
    subsectorGroups: subsectorRollups.length,
    methodologyVersion: SCORE_METHODOLOGY_VERSION,
  };
}
