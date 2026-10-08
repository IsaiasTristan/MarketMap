/**
 * performance.service — comprehensive portfolio performance analytics.
 * Extends the existing computePortfolioAnalytics with full Module 6 metrics.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooChartDaily } from "@/infrastructure/providers/yahoo-chart-http";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { annualizedRealizedVolatility, annualizedReturnFromDailyWindow } from "@/domain/calculations/volatility";
import {
  replayHoldingsBackward,
  buildDailyNav,
  openingPositionValue,
  flowAdjustedDailyReturns,
  flowMatchedBenchmarkDollars,
  type ReplayActivity,
  type ActivityTypeCode,
} from "@/lib/portfolio/holdings-replay";
import {
  sortinoRatio,
  maxDrawdown,
  drawdownSeries,
  maxDrawdownDuration,
  currentDrawdown,
  calmarRatio,
  upCaptureRatio,
  downCaptureRatio,
} from "@/domain/calculations/risk-adjusted";
import {
  skewness,
  excessKurtosis,
  returnHistogram,
  monthlyReturnCalendar,
  rolling12mReturn,
  rollingSharpeRatio,
} from "@/domain/calculations/distribution";
import {
  jensensAlpha,
  trackingError,
  rollingCorrelation,
  ols,
  vasicekBeta,
} from "@/domain/calculations/beta";
import type { HistogramBin } from "@/domain/calculations/distribution";

const TRADING_DAYS = 252;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  // Returns
  annualizedReturn: number;
  totalReturn: number;
  // Risk-adjusted
  sharpe: number;
  sortino: number;
  calmar: number;
  // Drawdown
  maxDrawdown: number;
  maxDrawdownDuration: number;
  currentDrawdown: number;
  // Benchmark comparison
  alpha: number;
  beta: number;
  trackingError: number;
  // Capture
  upCapture: number;
  downCapture: number;
  // Distribution
  volatility: number;
  skewness: number;
  excessKurtosis: number;
  // Meta
  nDays: number;
  periodStart: string;
  periodEnd: string;
  benchmarkCode: string;
  riskFreeRate: number;
  // Reconstruction basis: ACTUAL = real transaction-based holdings history,
  // BACKTEST = hypothetical constant-mix replay of today's composition.
  basis: PerformanceBasis;
}

export type PerformanceBasis = "ACTUAL" | "BACKTEST";

/** Data-quality flags surfaced on the actual-history reconstruction. */
export interface PerformanceDataQuality {
  earliestActivityDate: string | null;
  openingPositionValue: number;
  unknownActivityTypes: string[];
  unvaluedInstruments: string[];
  missingRawCloseDays: number;
}

/** Dollar headline figures for the actual-history view. */
export interface PerformanceDollarSummary {
  currentValue: number;
  openingValue: number;
  totalPnlDollars: number;
  netContributions: number;
  benchmarkValue: number;
  benchmarkPnlDollars: number;
}

export interface PerformanceSeries {
  dates: string[];
  portfolioReturns: number[];
  benchmarkReturns: number[];
  portfolioNAV: number[];
  benchmarkNAV: number[];
  drawdownSeries: number[];
  rolling12m: number[];
  rollingSharpe63d: number[];
  rollingCorr63d: number[];
  monthlyCalendar: Record<string, number>;
  returnHistogram: HistogramBin[];
  // Reconstruction basis + (ACTUAL only) real-dollar arrays and headline.
  basis: PerformanceBasis;
  navDollars?: number[];
  externalFlows?: number[];
  benchmarkDollars?: number[];
  flowDates?: string[];
  summary?: PerformanceDollarSummary;
  dataQuality?: PerformanceDataQuality;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// How far back to pull when the DB lacks enough history (constant-mix backtest).
const BACKTEST_YEARS = 5;
// Minimum common trading days to consider DB data sufficient.
const MIN_COMMON_DAYS = 63;

/** Fetch price map for a single ticker from Yahoo Chart API. */
async function fetchYahooPriceMap(
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  try {
    const bars = await fetchYahooChartDaily(ticker, startIso, endIso);
    return new Map(bars.map((b) => [b.date, b.adjClose]));
  } catch {
    return new Map();
  }
}

async function getConstantMixReturnSeries(
  portfolioId: string,
): Promise<{ dates: string[]; navSeries: number[] }> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });

  if (!positions.length) return { dates: [], navSeries: [] };

  const equityPositions = positions.filter((p) => !p.isCash && p.securityId);

  // Market-value weights at the latest available stored price, with
  // long/short sign applied. The constant-mix backtest below replays the
  // current portfolio composition over history.
  const lastPriceRows = await Promise.all(
    equityPositions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId! },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  let equityIdx = 0;
  const grossValues = positions.map((p) => {
    if (p.isCash) return p.cashAmount != null ? Number(p.cashAmount) : 0;
    const price = lastPriceRows[equityIdx]
      ? Number(lastPriceRows[equityIdx]!.adjClose)
      : 0;
    equityIdx++;
    return Math.abs(Number(p.shares) * price);
  });
  const totalGross = grossValues.reduce((s, v) => s + v, 0);
  const weights = positions.map((p, i) => ({
    ticker: p.isCash ? "CASH" : p.security!.ticker,
    secId: p.securityId,
    isCash: p.isCash,
    weight:
      (p.isCash ? 1 : p.isShort ? -1 : 1) *
      (totalGross > 0 ? grossValues[i]! / totalGross : 0),
  }));

  const equityWeights = weights.filter((w) => !w.isCash && w.secId);
  const secIds = equityWeights.map((w) => w.secId!);

  // ── 1. Try stored price history first ────────────────────────────────────
  const priceRows = await db.priceHistory.findMany({
    where: { securityId: { in: secIds } },
    orderBy: { tradeDate: "asc" },
  });

  const priceMap = new Map<string, Map<string, number>>();
  for (const row of priceRows) {
    if (!priceMap.has(row.securityId)) priceMap.set(row.securityId, new Map());
    priceMap
      .get(row.securityId)!
      .set(row.tradeDate.toISOString().slice(0, 10), Number(row.adjClose));
  }

  const dbDateSets = secIds.map((id) => {
    const m = priceMap.get(id);
    return m ? new Set(m.keys()) : new Set<string>();
  });
  let commonDates = (dbDateSets[0] ? [...dbDateSets[0]] : [])
    .filter((d) => dbDateSets.every((s) => s.has(d)))
    .sort();

  // ── 2. Fallback: fetch directly from Yahoo (constant-mix backtest) ────────
  // Treat the portfolio as if it had been held at these weights for the full
  // historical window, regardless of actual purchase dates.
  if (commonDates.length < MIN_COMMON_DAYS) {
    const endIso = new Date().toISOString().slice(0, 10);
    const startIso = new Date(
      Date.now() - BACKTEST_YEARS * 365.25 * 24 * 3600 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    // Fetch in parallel — typical portfolios are 5-30 tickers; Yahoo handles
    // this fine with the retry logic already built into fetchYahooChartDaily.
    const fetched = await Promise.all(
      equityWeights.map((w) => fetchYahooPriceMap(w.ticker, startIso, endIso)),
    );

    for (let i = 0; i < equityWeights.length; i++) {
      priceMap.set(equityWeights[i]!.secId!, fetched[i]!);
    }

    const yahooDateSets = secIds.map((id) => {
      const m = priceMap.get(id);
      return m ? new Set(m.keys()) : new Set<string>();
    });
    commonDates = (yahooDateSets[0] ? [...yahooDateSets[0]] : [])
      .filter((d) => yahooDateSets.every((s) => s.has(d)))
      .sort();
  }

  if (commonDates.length < 2) return { dates: [], navSeries: [] };

  // ── 3. Build the weighted daily NAV series ────────────────────────────────
  const navSeries: number[] = [1];
  for (let i = 1; i < commonDates.length; i++) {
    const prevDate = commonDates[i - 1];
    const curDate = commonDates[i];
    let portReturn = 0;
    for (const w of weights) {
      if (w.isCash || !w.secId) continue;
      const pm = priceMap.get(w.secId);
      if (!pm) continue;
      const prev = pm.get(prevDate);
      const cur = pm.get(curDate);
      if (prev && cur && prev > 0) {
        portReturn += w.weight * ((cur - prev) / prev);
      }
    }
    navSeries.push(navSeries[navSeries.length - 1] * (1 + portReturn));
  }

  return { dates: commonDates, navSeries };
}

// ── Actual-history reconstruction (brokerage-linked portfolios) ─────────────

/**
 * Unified portfolio history. For a brokerage-linked portfolio with a
 * transaction ledger this is the ACTUAL day-by-day reconstruction (real dollar
 * NAV + flow-adjusted time-weighted returns). Otherwise it falls back to the
 * hypothetical constant-mix BACKTEST used for manually-built portfolios.
 *
 * `navSeries` is an index (starts at 1) whose simple daily ratios equal the
 * portfolio's daily returns, so every existing metric — which calls
 * `dailyReturnsFromAdjustedCloses(navSeries)` — keeps working unchanged. For
 * ACTUAL that index is built from the flow-adjusted returns; for BACKTEST it is
 * the constant-mix NAV as before.
 */
interface PortfolioHistory {
  basis: PerformanceBasis;
  dates: string[];
  navSeries: number[];
  navDollars?: number[];
  externalFlows?: number[];
  openingValue?: number;
  netContributions?: number;
  totalPnlDollars?: number;
  dataQuality?: PerformanceDataQuality;
}

async function getPortfolioHistory(portfolioId: string): Promise<PortfolioHistory> {
  const link = await db.brokerageAccountLink.findUnique({
    where: { portfolioId },
    select: { id: true, activityCount: true, earliestActivityDate: true, activityIssuesJson: true },
  });

  if (link && link.activityCount > 0) {
    const actual = await reconstructActualHistory(portfolioId, link.id, link.activityIssuesJson);
    if (actual) return actual;
    // fall through to backtest if reconstruction couldn't produce a series
  }

  const { dates, navSeries } = await getConstantMixReturnSeries(portfolioId);
  return { basis: "BACKTEST", dates, navSeries };
}

/** Build the real-dollar, flow-adjusted history from the activity ledger. */
async function reconstructActualHistory(
  portfolioId: string,
  accountLinkId: string,
  activityIssuesJson: unknown,
): Promise<PortfolioHistory | null> {
  // Current (signed) holdings + cash — the reconstruction anchor.
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });
  const currentShares: Record<string, number> = {};
  let currentCash = 0;
  for (const p of positions) {
    if (p.isCash) {
      currentCash += p.cashAmount != null ? Number(p.cashAmount) : 0;
      continue;
    }
    if (!p.security) continue;
    const signed = (p.isShort ? -1 : 1) * Number(p.shares);
    currentShares[p.security.ticker.toUpperCase()] =
      (currentShares[p.security.ticker.toUpperCase()] ?? 0) + signed;
  }

  const rows = await db.brokerageActivity.findMany({
    where: { accountLinkId },
    orderBy: { tradeDate: "asc" },
    select: {
      activityType: true,
      ticker: true,
      units: true,
      amount: true,
      isOption: true,
      tradeDate: true,
    },
  });
  if (rows.length === 0) return null;

  const activities: ReplayActivity[] = rows.map((r) => ({
    date: r.tradeDate.toISOString().slice(0, 10),
    activityType: r.activityType as ActivityTypeCode,
    ticker: r.ticker,
    units: r.units != null ? Number(r.units) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    isOption: r.isOption,
  }));

  const replay = replayHoldingsBackward(currentShares, currentCash, activities);
  const earliest = activities[0]!.date;
  const today = new Date().toISOString().slice(0, 10);

  // Prices (unadjusted close, adjClose fallback) for every ledger ticker.
  const secIdByTicker = new Map<string, string>();
  const secs = await db.security.findMany({
    where: { ticker: { in: replay.tickers } },
    select: { id: true, ticker: true },
  });
  for (const s of secs) secIdByTicker.set(s.ticker.toUpperCase(), s.id);

  const priceRows = await db.priceHistory.findMany({
    where: {
      securityId: { in: [...secIdByTicker.values()] },
      tradeDate: { gte: new Date(`${earliest}T00:00:00Z`), lte: new Date(`${today}T23:59:59Z`) },
    },
    select: { securityId: true, tradeDate: true, close: true, adjClose: true },
    orderBy: { tradeDate: "asc" },
  });

  const idByTicker = new Map([...secIdByTicker.entries()].map(([t, id]) => [id, t]));
  const closeByTickerDate = new Map<string, Map<string, number>>();
  const tradingDateSet = new Set<string>();
  let missingRawCloseDays = 0;
  for (const r of priceRows) {
    const ticker = idByTicker.get(r.securityId);
    if (!ticker) continue;
    const d = r.tradeDate.toISOString().slice(0, 10);
    tradingDateSet.add(d);
    let raw = r.close != null ? Number(r.close) : null;
    if (raw == null) {
      raw = Number(r.adjClose);
      missingRawCloseDays++;
    }
    if (!closeByTickerDate.has(ticker)) closeByTickerDate.set(ticker, new Map());
    closeByTickerDate.get(ticker)!.set(d, raw);
  }

  const tradingDates = [...tradingDateSet].filter((d) => d >= earliest && d <= today).sort();
  if (tradingDates.length < 2) return null;

  const priceOf = (ticker: string, date: string): number | null =>
    closeByTickerDate.get(ticker.toUpperCase())?.get(date) ?? null;

  const { navByDate, flowByDate } = buildDailyNav(replay, tradingDates, priceOf);

  const dailyReturns = flowAdjustedDailyReturns(navByDate, flowByDate);
  const navIndex: number[] = [1];
  for (const r of dailyReturns) navIndex.push(navIndex[navIndex.length - 1] * (1 + r));

  const netContributions = flowByDate.reduce((s, f) => s + f, 0);
  const currentValue = navByDate[navByDate.length - 1] ?? 0;
  const openingValue = openingPositionValue(replay, tradingDates[0], priceOf);
  const totalPnlDollars = currentValue - netContributions;

  const issues = (activityIssuesJson ?? {}) as {
    unknownTypes?: string[];
    unvaluedInstruments?: string[];
  };

  return {
    basis: "ACTUAL",
    dates: tradingDates,
    navSeries: navIndex,
    navDollars: navByDate,
    externalFlows: flowByDate,
    openingValue,
    netContributions,
    totalPnlDollars,
    dataQuality: {
      earliestActivityDate: earliest,
      openingPositionValue: openingValue,
      unknownActivityTypes: issues.unknownTypes ?? [],
      unvaluedInstruments: issues.unvaluedInstruments ?? [],
      missingRawCloseDays,
    },
  };
}

// Maps benchmark codes to Yahoo tickers (all in KNOWN_BARE_INDEX_CODES so
// toYahooSymbol will prefix them with `^` automatically).
const BENCHMARK_TICKER: Record<string, string> = {
  SP500: "GSPC",
  NASDAQ: "IXIC",
  DOW: "DJI",
};

/** Benchmark adjusted-close price map over [start, end] (DB, Yahoo fallback). */
async function getBenchmarkPriceMap(
  benchmarkCode: "SP500" | "NASDAQ" | "DOW",
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const bench = await db.benchmark.findUnique({
    where: { code: benchmarkCode },
    include: {
      priceHistory: {
        where: { tradeDate: { gte: new Date(startIso), lte: new Date(endIso) } },
        orderBy: { tradeDate: "asc" },
      },
    },
  });
  if (bench?.priceHistory?.length) {
    return new Map(
      bench.priceHistory.map((r) => [r.tradeDate.toISOString().slice(0, 10), Number(r.adjClose)]),
    );
  }
  const ticker = BENCHMARK_TICKER[benchmarkCode] ?? "GSPC";
  return fetchYahooPriceMap(ticker, startIso, endIso);
}

async function getBenchmarkReturnSeries(
  benchmarkCode: "SP500" | "NASDAQ" | "DOW",
  dates: string[],
): Promise<number[]> {
  if (dates.length < 2) return [];
  const benchPriceMap = await getBenchmarkPriceMap(benchmarkCode, dates[0], dates[dates.length - 1]);
  const returns: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = benchPriceMap.get(dates[i - 1]);
    const cur = benchPriceMap.get(dates[i]);
    if (prev && cur && prev > 0) {
      returns.push((cur - prev) / prev);
    } else {
      returns.push(0);
    }
  }
  return returns;
}

/** Benchmark closes aligned 1:1 to `dates` (null when a date has no bar). */
async function getBenchmarkCloseSeries(
  benchmarkCode: "SP500" | "NASDAQ" | "DOW",
  dates: string[],
): Promise<(number | null)[]> {
  if (dates.length === 0) return [];
  const benchPriceMap = await getBenchmarkPriceMap(benchmarkCode, dates[0], dates[dates.length - 1]);
  return dates.map((d) => benchPriceMap.get(d) ?? null);
}

async function getRiskFreeRate(): Promise<number> {
  const row = await db.riskFreeRate.findFirst({
    orderBy: { tradeDate: "desc" },
  });
  return row ? Number(row.annualRate) : 0.05;
}

// ── Main exports ───────────────────────────────────────────────────────────

export async function computePerformanceMetrics(
  portfolioId: string,
  benchmarkCode: "SP500" | "NASDAQ" | "DOW" = "SP500",
): Promise<PerformanceMetrics | null> {
  const [history, rfRate] = await Promise.all([
    getPortfolioHistory(portfolioId),
    getRiskFreeRate(),
  ]);
  const { dates, navSeries, basis } = history;

  if (dates.length < 63) return null;

  const portReturns = dailyReturnsFromAdjustedCloses(navSeries);
  const benchReturns = await getBenchmarkReturnSeries(benchmarkCode, dates);

  const n = Math.min(portReturns.length, benchReturns.length);
  const pRet = portReturns.slice(0, n);
  const bRet = benchReturns.slice(0, n);

  const annRet = annualizedReturnFromDailyWindow(pRet);
  const annVol = annualizedRealizedVolatility(pRet) ?? 0;
  const sharpe = annVol > 0 ? (annRet - rfRate) / annVol : NaN;

  const { alpha, beta } = ols(pRet, bRet);

  return {
    annualizedReturn: annRet,
    totalReturn: navSeries[navSeries.length - 1] - 1,
    sharpe,
    sortino: sortinoRatio(pRet, rfRate),
    calmar: calmarRatio(pRet),
    maxDrawdown: maxDrawdown(pRet),
    maxDrawdownDuration: maxDrawdownDuration(pRet),
    currentDrawdown: currentDrawdown(pRet),
    alpha: alpha * TRADING_DAYS,
    beta: vasicekBeta(beta),
    trackingError: trackingError(pRet, bRet),
    upCapture: upCaptureRatio(pRet, bRet),
    downCapture: downCaptureRatio(pRet, bRet),
    volatility: annVol,
    skewness: skewness(pRet),
    excessKurtosis: excessKurtosis(pRet),
    nDays: n,
    periodStart: dates[0],
    periodEnd: dates[n],
    benchmarkCode,
    riskFreeRate: rfRate,
    basis,
  };
}

export async function computePerformanceSeries(
  portfolioId: string,
  benchmarkCode: "SP500" | "NASDAQ" | "DOW" = "SP500",
): Promise<PerformanceSeries | null> {
  const [history, rfRate] = await Promise.all([
    getPortfolioHistory(portfolioId),
    getRiskFreeRate(),
  ]);
  const { dates, navSeries, basis } = history;

  if (dates.length < 10) return null;

  const portReturns = dailyReturnsFromAdjustedCloses(navSeries);
  const benchReturns = await getBenchmarkReturnSeries(benchmarkCode, dates);
  const n = Math.min(portReturns.length, benchReturns.length);
  const pRet = portReturns.slice(0, n);
  const bRet = benchReturns.slice(0, n);
  const usedDates = dates.slice(1, n + 1);

  // Benchmark NAV series
  const benchNAV: number[] = [1];
  for (const r of bRet) benchNAV.push(benchNAV[benchNAV.length - 1] * (1 + r));

  const calendar = monthlyReturnCalendar(usedDates, pRet);
  const hist = returnHistogram(pRet, 30);
  const rolling12 = rolling12mReturn(pRet, 252);
  const rollingSharpe = rollingSharpeRatio(pRet, rfRate, 63);
  const rollingCorr = rollingCorrelation(pRet, bRet, 63);
  const dd = drawdownSeries(pRet);

  const base: PerformanceSeries = {
    dates: usedDates,
    portfolioReturns: pRet,
    benchmarkReturns: bRet,
    portfolioNAV: navSeries.slice(0, n + 1),
    benchmarkNAV: benchNAV,
    drawdownSeries: dd,
    rolling12m: rolling12,
    rollingSharpe63d: rollingSharpe,
    rollingCorr63d: rollingCorr,
    monthlyCalendar: calendar,
    returnHistogram: hist,
    basis,
  };

  // Real-dollar arrays + headline summary, actual-history only. Aligned to the
  // same index the charts use: navDollars[i+1] pairs with usedDates[i], matching
  // portfolioNAV.
  if (basis === "ACTUAL" && history.navDollars && history.externalFlows) {
    const navDollars = history.navDollars.slice(0, n + 1);
    const externalFlows = history.externalFlows.slice(0, n + 1);
    const benchCloses = await getBenchmarkCloseSeries(benchmarkCode, dates.slice(0, n + 1));
    const benchmarkDollars = flowMatchedBenchmarkDollars(externalFlows, benchCloses);

    const currentValue = navDollars[navDollars.length - 1] ?? 0;
    const netContributions = history.netContributions ?? externalFlows.reduce((s, f) => s + f, 0);
    const openingValue = history.openingValue ?? 0;
    const totalPnlDollars = history.totalPnlDollars ?? currentValue - netContributions;
    const benchmarkValue = benchmarkDollars[benchmarkDollars.length - 1] ?? 0;
    const benchmarkPnlDollars = benchmarkValue - netContributions;

    return {
      ...base,
      navDollars,
      externalFlows,
      benchmarkDollars,
      flowDates: dates.slice(0, n + 1),
      summary: {
        currentValue,
        openingValue,
        totalPnlDollars,
        netContributions,
        benchmarkValue,
        benchmarkPnlDollars,
      },
      dataQuality: history.dataQuality,
    };
  }

  return base;
}
