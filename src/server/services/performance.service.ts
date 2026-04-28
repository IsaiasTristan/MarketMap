/**
 * performance.service — comprehensive portfolio performance analytics.
 * Extends the existing computePortfolioAnalytics with full Module 6 metrics.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooChartDaily } from "@/infrastructure/providers/yahoo-chart-http";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { annualizedRealizedVolatility, annualizedReturnFromDailyWindow } from "@/domain/calculations/volatility";
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

async function getPortfolioReturnSeries(
  portfolioId: string,
): Promise<{ dates: string[]; navSeries: number[] }> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });

  if (!positions.length) return { dates: [], navSeries: [] };

  // Market-value weights at the latest available stored price, with
  // long/short sign applied. The constant-mix backtest below replays the
  // current portfolio composition over history.
  const lastPriceRows = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );
  const grossValues = positions.map((p, i) => {
    const price = lastPriceRows[i] ? Number(lastPriceRows[i]!.adjClose) : 0;
    return Math.abs(Number(p.shares) * price);
  });
  const totalGross = grossValues.reduce((s, v) => s + v, 0);
  const weights = positions.map((p, i) => ({
    ticker: p.security.ticker,
    secId: p.securityId,
    weight:
      (p.isShort ? -1 : 1) *
      (totalGross > 0 ? grossValues[i]! / totalGross : 0),
  }));

  const secIds = weights.map((w) => w.secId);

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
      weights.map((w) => fetchYahooPriceMap(w.ticker, startIso, endIso)),
    );

    for (let i = 0; i < weights.length; i++) {
      priceMap.set(weights[i].secId, fetched[i]);
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

// Maps benchmark codes to Yahoo tickers (all in KNOWN_BARE_INDEX_CODES so
// toYahooSymbol will prefix them with `^` automatically).
const BENCHMARK_TICKER: Record<string, string> = {
  SP500: "GSPC",
  NASDAQ: "IXIC",
  DOW: "DJI",
};

async function getBenchmarkReturnSeries(
  benchmarkCode: "SP500" | "NASDAQ" | "DOW",
  dates: string[],
): Promise<number[]> {
  if (dates.length < 2) return [];

  // ── 1. Try the stored Benchmark table ────────────────────────────────────
  const bench = await db.benchmark.findUnique({
    where: { code: benchmarkCode },
    include: {
      priceHistory: {
        where: {
          tradeDate: {
            gte: new Date(dates[0]),
            lte: new Date(dates[dates.length - 1]),
          },
        },
        orderBy: { tradeDate: "asc" },
      },
    },
  });

  let benchPriceMap: Map<string, number>;

  if (bench?.priceHistory?.length) {
    benchPriceMap = new Map(
      bench.priceHistory.map((r) => [
        r.tradeDate.toISOString().slice(0, 10),
        Number(r.adjClose),
      ]),
    );
  } else {
    // ── 2. Fallback: fetch directly from Yahoo ────────────────────────────
    const ticker = BENCHMARK_TICKER[benchmarkCode] ?? "GSPC";
    benchPriceMap = await fetchYahooPriceMap(ticker, dates[0], dates[dates.length - 1]);
  }

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
  const [{ dates, navSeries }, rfRate] = await Promise.all([
    getPortfolioReturnSeries(portfolioId),
    getRiskFreeRate(),
  ]);

  if (dates.length < 63) return null;

  const portReturns = dailyReturnsFromAdjustedCloses(navSeries);
  const benchReturns = await getBenchmarkReturnSeries(benchmarkCode, dates);

  const n = Math.min(portReturns.length, benchReturns.length);
  const pRet = portReturns.slice(0, n);
  const bRet = benchReturns.slice(0, n);

  const annRet = annualizedReturnFromDailyWindow(pRet);
  const annVol = annualizedRealizedVolatility(pRet) ?? 0;
  const sharpe = annVol > 0 ? (annRet - rfRate) / annVol : NaN;

  const { alpha, beta, rSquared } = ols(pRet, bRet);

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
  };
}

export async function computePerformanceSeries(
  portfolioId: string,
  benchmarkCode: "SP500" | "NASDAQ" | "DOW" = "SP500",
): Promise<PerformanceSeries | null> {
  const [{ dates, navSeries }, rfRate] = await Promise.all([
    getPortfolioReturnSeries(portfolioId),
    getRiskFreeRate(),
  ]);

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

  return {
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
  };
}
