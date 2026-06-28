/**
 * Engine 2 — read side for the Financial Analysis (FA) view. Shapes the stored
 * quarterly FundamentalPeriod rows (+ per-period market cap / EV from the FMP
 * key-metrics blob), the latest FundamentalSnapshot (current market cap / EV),
 * and the latest RevisionSnapshot (forward analyst estimate) into the columns
 * the pure builder lays out. No mutation.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  actualLabel,
  aggregateAnnual,
  attachIncomeSpark,
  attachSparkByKey,
  buildMetricRows,
  buildMonthMap,
  buildStatement,
  estimateLabel,
  SPARK_TRAIL_QUARTERS,
  toQuarterlyRunRate,
  type FaBasis,
  type FaColumnInput,
  type FaColumnMetrics,
  type FaColumnValuation,
  type FaMetricRow,
  type FaPeriodInput,
  type FaStatement,
} from "@/lib/fundamental/financials";

const MAX_ANNUAL_COLUMNS = 6;
const MAX_QUARTER_COLUMNS = 8;
const MAX_ESTIMATE_ANNUAL = 2;
const MAX_ESTIMATE_QUARTER = 8;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dec(v: { toString(): string } | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function jnum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface FinancialsPayload extends FaStatement {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  basis: FaBasis;
  currency: string | null;
  snapshotDate: string | null;
  valuationMetrics: FaMetricRow[];
  returnMetrics: FaMetricRow[];
}

interface EstimateTriple {
  avg?: number | null;
}
interface EstimatePeriodJson {
  fiscalDate?: string;
  revenue?: EstimateTriple;
  ebitda?: EstimateTriple;
  netIncome?: EstimateTriple;
  eps?: EstimateTriple;
  numAnalystsRevenue?: number | null;
  numAnalystsEps?: number | null;
}

function sum(values: Array<number | null>): number | null {
  let s = 0;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) return null;
    s += v;
  }
  return values.length ? s : null;
}

function buildCurrentColumn(
  quarters: FaPeriodInput[],
  liveMktCap: number | null,
  liveEv: number | null,
  basis: FaBasis,
): FaColumnInput | null {
  if (quarters.length < 4) return null;
  const last4 = quarters.slice(-4);
  const latest = quarters[quarters.length - 1]!;
  const ttm: FaPeriodInput = {
    fiscalDate: latest.fiscalDate,
    fiscalYear: latest.fiscalYear,
    fiscalLabel: "TTM",
    revenue: sum(last4.map((q) => q.revenue)),
    grossProfit: sum(last4.map((q) => q.grossProfit)),
    operatingIncome: sum(last4.map((q) => q.operatingIncome)),
    ebitda: sum(last4.map((q) => q.ebitda)),
    netIncome: sum(last4.map((q) => q.netIncome)),
    operatingCashFlow: sum(last4.map((q) => q.operatingCashFlow)),
    capex: sum(last4.map((q) => q.capex)),
    freeCashFlow: sum(last4.map((q) => q.freeCashFlow)),
    totalDebt: latest.totalDebt,
    cash: latest.cash,
    totalAssets: latest.totalAssets,
    totalEquity: latest.totalEquity,
    preferredEquity: latest.preferredEquity,
    minorityInterest: latest.minorityInterest,
    sharesDiluted: latest.sharesDiluted,
    roic: latest.roic,
    netDebtToEbitda: latest.netDebtToEbitda,
    marketCap: liveMktCap ?? latest.marketCap,
    enterpriseValue: liveEv ?? latest.enterpriseValue,
  };
  // On a quarterly view the LTM column is shown as an average-quarter run-rate
  // (flows / 4); point-in-time capitalization items stay intact.
  const data = basis === "quarter" ? toQuarterlyRunRate(ttm) : ttm;
  return { kind: "current", label: "LTM", fiscalDate: latest.fiscalDate, data };
}

function emptyPeriod(fiscalDate: string): FaPeriodInput {
  return {
    fiscalDate,
    fiscalYear: null,
    fiscalLabel: null,
    revenue: null,
    grossProfit: null,
    operatingIncome: null,
    ebitda: null,
    netIncome: null,
    operatingCashFlow: null,
    capex: null,
    freeCashFlow: null,
    totalDebt: null,
    cash: null,
    totalAssets: null,
    totalEquity: null,
    preferredEquity: null,
    minorityInterest: null,
    sharesDiluted: null,
    roic: null,
    netDebtToEbitda: null,
    marketCap: null,
    enterpriseValue: null,
  };
}

function buildEstimateColumns(
  estimatesJson: unknown,
  basis: FaBasis,
  latestActualDate: string,
  monthMap: Map<string, { quarter: string; yearOffset: number }>,
): FaColumnInput[] {
  if (!estimatesJson || typeof estimatesJson !== "object") return [];
  const blob = estimatesJson as { annual?: EstimatePeriodJson[]; quarter?: EstimatePeriodJson[] };
  const periods = basis === "annual" ? blob.annual : blob.quarter;
  if (!Array.isArray(periods) || periods.length === 0) return [];
  const limit = basis === "annual" ? MAX_ESTIMATE_ANNUAL : MAX_ESTIMATE_QUARTER;
  const forward = [...periods]
    .filter((p): p is EstimatePeriodJson & { fiscalDate: string } => !!p.fiscalDate && p.fiscalDate > latestActualDate)
    .sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate))
    .slice(0, limit);

  const out: FaColumnInput[] = [];
  for (const fwd of forward) {
    const revenue = jnum(fwd.revenue?.avg);
    const ebitda = jnum(fwd.ebitda?.avg);
    const netIncome = jnum(fwd.netIncome?.avg);
    const eps = jnum(fwd.eps?.avg);
    if (revenue === null && ebitda === null && netIncome === null && eps === null) continue;
    const data = emptyPeriod(fwd.fiscalDate);
    data.revenue = revenue;
    data.ebitda = ebitda;
    data.netIncome = netIncome;
    out.push({
      kind: "estimate",
      label: estimateLabel(fwd.fiscalDate, basis, monthMap),
      fiscalDate: fwd.fiscalDate,
      data,
      estimateEps: eps,
      estimateAnalysts: jnum(fwd.numAnalystsRevenue) ?? jnum(fwd.numAnalystsEps),
    });
  }
  return out;
}

function safeRatio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

interface QuarterPoint {
  fiscalDate: string;
  revenue: number | null;
  ebitda: number | null;
  netIncome: number | null;
}

/**
 * Unified ascending quarterly timeline = actual reported quarters followed by
 * forward consensus quarters (those after the latest reported quarter). Drives
 * the NTM (next-4-quarter) valuation denominator at every column — subsequent
 * actuals for historical columns, consensus for the current / forward columns.
 */
function buildQuarterTimeline(
  quarters: FaPeriodInput[],
  estimatesJson: unknown,
  latestActualDate: string,
): QuarterPoint[] {
  const points: QuarterPoint[] = quarters.map((q) => ({
    fiscalDate: q.fiscalDate,
    revenue: q.revenue,
    ebitda: q.ebitda,
    netIncome: q.netIncome,
  }));
  if (estimatesJson && typeof estimatesJson === "object") {
    const blob = estimatesJson as { quarter?: EstimatePeriodJson[] };
    for (const p of Array.isArray(blob.quarter) ? blob.quarter : []) {
      if (!p.fiscalDate || p.fiscalDate <= latestActualDate) continue;
      points.push({
        fiscalDate: p.fiscalDate,
        revenue: jnum(p.revenue?.avg),
        ebitda: jnum(p.ebitda?.avg),
        netIncome: jnum(p.netIncome?.avg),
      });
    }
  }
  return points.sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
}

/** Sum of the next 4 quarters strictly after `date`; null when fewer than 4 exist. */
function ntmAfter(
  timeline: QuarterPoint[],
  date: string,
): { ntmRevenue: number | null; ntmEbitda: number | null; ntmNetIncome: number | null } {
  const next4 = timeline.filter((p) => p.fiscalDate > date).slice(0, 4);
  if (next4.length < 4) return { ntmRevenue: null, ntmEbitda: null, ntmNetIncome: null };
  return {
    ntmRevenue: sum(next4.map((p) => p.revenue)),
    ntmEbitda: sum(next4.map((p) => p.ebitda)),
    ntmNetIncome: sum(next4.map((p) => p.netIncome)),
  };
}

/** Trailing-12-month EBITDA = sum of the 4 actual quarters on/before `date`. */
function ttmEbitdaAsOf(quarters: FaPeriodInput[], date: string): number | null {
  const upto = quarters.filter((q) => q.fiscalDate <= date).slice(-4);
  if (upto.length < 4) return null;
  return sum(upto.map((q) => q.ebitda));
}

/** Net Leverage = (total debt − cash) / TTM EBITDA, the same basis in every column. */
function netLeverageAsOf(period: FaPeriodInput, quarters: FaPeriodInput[]): number | null {
  const netDebt = period.totalDebt !== null && period.cash !== null ? period.totalDebt - period.cash : null;
  return safeRatio(netDebt, ttmEbitdaAsOf(quarters, period.fiscalDate));
}

export async function getFinancials(ticker: string, basis: FaBasis): Promise<FinancialsPayload | null> {
  const t = ticker.toUpperCase();
  const [rows, snap, ref, revSnap] = await Promise.all([
    prisma.fundamentalPeriod.findMany({
      where: { ticker: t, periodType: "quarter" },
      orderBy: { fiscalDate: "asc" },
      select: {
        fiscalDate: true,
        fiscalLabel: true,
        revenue: true,
        grossProfit: true,
        operatingIncome: true,
        ebitda: true,
        netIncome: true,
        operatingCashFlow: true,
        capex: true,
        freeCashFlow: true,
        totalDebt: true,
        cash: true,
        totalAssets: true,
        totalEquity: true,
        preferredEquity: true,
        minorityInterest: true,
        sharesDiluted: true,
        roic: true,
        netDebtToEbitda: true,
        statementJson: true,
        ratiosJson: true,
      },
    }),
    prisma.fundamentalSnapshot.findFirst({
      where: { ticker: t },
      orderBy: { snapshotDate: "desc" },
      select: {
        snapshotDate: true,
        marketCap: true,
        enterpriseValue: true,
        roic: true,
        netDebtToEbitda: true,
      },
    }),
    prisma.revisionReference.findUnique({
      where: { ticker: t },
      select: { companyName: true, sector: true, subsector: true },
    }),
    prisma.revisionSnapshot.findFirst({
      where: { ticker: t },
      orderBy: { snapshotDate: "desc" },
      select: { estimatesJson: true },
    }),
  ]);

  if (rows.length === 0) return null;

  let currency: string | null = null;
  const quarters: FaPeriodInput[] = rows.map((r) => {
    const stmt = (r.statementJson ?? {}) as Record<string, unknown>;
    const km = ((r.ratiosJson ?? {}) as Record<string, unknown>).keyMetrics as Record<string, unknown> | null | undefined;
    if (typeof stmt.reportedCurrency === "string") currency = stmt.reportedCurrency;
    const fiscalDate = isoOf(r.fiscalDate);
    const fyRaw = stmt.fiscalYear;
    const fiscalYear =
      typeof fyRaw === "number" ? fyRaw : typeof fyRaw === "string" && fyRaw ? Number(fyRaw) : Number(fiscalDate.slice(0, 4));
    return {
      fiscalDate,
      fiscalYear: Number.isFinite(fiscalYear) ? fiscalYear : null,
      fiscalLabel: r.fiscalLabel,
      revenue: dec(r.revenue),
      grossProfit: dec(r.grossProfit),
      operatingIncome: dec(r.operatingIncome),
      ebitda: dec(r.ebitda),
      netIncome: dec(r.netIncome),
      operatingCashFlow: dec(r.operatingCashFlow),
      capex: dec(r.capex),
      freeCashFlow: dec(r.freeCashFlow),
      totalDebt: dec(r.totalDebt),
      cash: dec(r.cash),
      totalAssets: dec(r.totalAssets),
      totalEquity: dec(r.totalEquity),
      preferredEquity: dec(r.preferredEquity),
      minorityInterest: dec(r.minorityInterest),
      sharesDiluted: dec(r.sharesDiluted),
      roic: r.roic,
      netDebtToEbitda: r.netDebtToEbitda,
      marketCap: jnum(km?.marketCap),
      enterpriseValue: jnum(km?.enterpriseValue),
    };
  });

  const monthMap = buildMonthMap(quarters);
  const history = basis === "annual" ? aggregateAnnual(quarters) : quarters;
  const maxCols = basis === "annual" ? MAX_ANNUAL_COLUMNS : MAX_QUARTER_COLUMNS;
  const trimmed = history.slice(-maxCols);

  const latestActualDate = quarters[quarters.length - 1]!.fiscalDate;
  const liveMktCap = dec(snap?.marketCap);
  const liveEv = dec(snap?.enterpriseValue);
  const timeline = buildQuarterTimeline(quarters, revSnap?.estimatesJson, latestActualDate);

  const columns: FaColumnInput[] = trimmed.map((p) => ({
    kind: "period",
    label: actualLabel(p, basis),
    fiscalDate: p.fiscalDate,
    data: p,
  }));

  // Column-aligned metric inputs, built in the same order columns are pushed:
  // historical period columns, then the LTM column, then forward estimates.
  const returns: Array<FaColumnMetrics | null> = [];
  const valuations: Array<FaColumnValuation | null> = [];

  for (const p of trimmed) {
    returns.push({
      netIncome: p.netIncome,
      totalEquity: p.totalEquity,
      totalAssets: p.totalAssets,
      roic: p.roic,
      netDebtToEbitda: netLeverageAsOf(p, quarters),
    });
    valuations.push({ ev: p.enterpriseValue, marketCap: p.marketCap, ...ntmAfter(timeline, p.fiscalDate) });
  }

  const current = buildCurrentColumn(quarters, liveMktCap, liveEv, basis);
  if (current) {
    columns.push(current);
    // LTM ratios use full-TTM net income (un-divided by the run-rate) + latest
    // balance-sheet equity / assets; valuation is priced at the current snapshot.
    const last4 = quarters.slice(-4);
    const latest = quarters[quarters.length - 1]!;
    returns.push({
      netIncome: sum(last4.map((q) => q.netIncome)),
      totalEquity: latest.totalEquity,
      totalAssets: latest.totalAssets,
      roic: snap?.roic ?? latest.roic,
      netDebtToEbitda: netLeverageAsOf(latest, quarters) ?? snap?.netDebtToEbitda ?? latest.netDebtToEbitda ?? null,
    });
    valuations.push({
      ev: liveEv ?? latest.enterpriseValue,
      marketCap: liveMktCap ?? latest.marketCap,
      ...ntmAfter(timeline, latestActualDate),
    });
  }

  const estimates = buildEstimateColumns(revSnap?.estimatesJson, basis, latestActualDate, monthMap);
  for (const est of estimates) {
    columns.push(est);
    returns.push(null);
    valuations.push({
      ev: liveEv,
      marketCap: liveMktCap,
      ...ntmAfter(timeline, est.fiscalDate ?? est.data.fiscalDate),
    });
  }

  const statement = buildStatement(columns, basis);
  const { valuationMetrics, returnMetrics } = buildMetricRows(returns, valuations);

  const sparkQuarters = quarters.slice(-SPARK_TRAIL_QUARTERS);
  const sparkCols: FaColumnInput[] = sparkQuarters.map((p) => ({
    kind: "period",
    label: actualLabel(p, "quarter"),
    fiscalDate: p.fiscalDate,
    data: p,
  }));
  const sparkStatement = buildStatement(sparkCols, "quarter");
  const sparkReturns: Array<FaColumnMetrics | null> = [];
  const sparkValuations: Array<FaColumnValuation | null> = [];
  for (const p of sparkQuarters) {
    sparkReturns.push({
      netIncome: p.netIncome,
      totalEquity: p.totalEquity,
      totalAssets: p.totalAssets,
      roic: p.roic,
      netDebtToEbitda: netLeverageAsOf(p, quarters),
    });
    sparkValuations.push({
      ev: p.enterpriseValue,
      marketCap: p.marketCap,
      ...ntmAfter(timeline, p.fiscalDate),
    });
  }
  const sparkMetrics = buildMetricRows(sparkReturns, sparkValuations);

  const income = attachIncomeSpark(statement.income, sparkStatement.income);
  const perShare = attachSparkByKey(statement.perShare, sparkStatement.perShare);
  const bridge = attachSparkByKey(statement.bridge, sparkStatement.bridge);
  const valuationMetricsWithSpark = attachSparkByKey(valuationMetrics, sparkMetrics.valuationMetrics);
  const returnMetricsWithSpark = attachSparkByKey(returnMetrics, sparkMetrics.returnMetrics);

  return {
    ...statement,
    income,
    perShare,
    bridge,
    ticker: t,
    companyName: ref?.companyName ?? null,
    sector: ref?.sector ?? null,
    subsector: ref?.subsector ?? null,
    basis,
    currency,
    snapshotDate: snap ? isoOf(snap.snapshotDate) : null,
    valuationMetrics: valuationMetricsWithSpark,
    returnMetrics: returnMetricsWithSpark,
  };
}
