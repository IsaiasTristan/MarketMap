/**
 * risk.service — position-level and portfolio-level risk analytics.
 *
 * Volatility windows:
 *   vol1y  = 252-day (1-year) lookback  — shown prominently in UI
 *   vol5y  = up to 1260-day (5-year) lookback — full available history
 *
 * VaR is always 1-day horizon, computed from the 252-day (1Y) covariance matrix.
 * Using a 1Y lookback for VaR is industry-standard; it captures recent market
 * regime without over-weighting very old stress periods.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { annualizedRealizedVolatility } from "@/domain/calculations/volatility";
import { correlationMatrix } from "@/domain/calculations/correlation";
import { volDecomposition } from "@/domain/calculations/vol-decomp";
import {
  parametricVaR,
  historicalVaR,
  expectedShortfall,
  portfolioParametricVaR,
  stressedVaR,
  marginalVaR,
  componentVaR,
  Z_95,
  Z_99,
} from "@/domain/calculations/var";
import {
  maxDrawdown,
  drawdownSeries,
  maxDrawdownDuration,
  currentDrawdown,
} from "@/domain/calculations/risk-adjusted";
import { rollingBeta, vasicekBeta, ols } from "@/domain/calculations/beta";
import { sharpeRatio } from "@/domain/calculations/sharpe";
import {
  rollingVolSparkline,
  rollingSharpeSparkline,
} from "@/domain/calculations/rolling-risk-series";
import { riskFreeAnnual } from "@/infrastructure/config/env";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PositionRisk {
  ticker: string;
  name: string;
  /** Gross weight: |market value| / Σ |market value|. Always in [0, 1]. */
  weight: number;
  isShort: boolean;
  marketValue: number;
  /** Latest adjClose — used for per-share daily vol ($/sh). */
  lastPrice: number;
  varDollar95: number;
  varDollar99: number;
  marginalVar: number;
  componentVar: number;
  vol21d: number;
  vol63d: number;
  vol126d: number;
  vol252d: number;
  sharpe21d: number;
  sharpe63d: number;
  sharpe126d: number;
  /** Historical expected shortfall (1-day 95%) in dollars. */
  cvar95: number;
  /**
   * Parametric daily 95% VaR as a return fraction. Populated for notional-free
   * reference rows (indices); undefined for positions/total where the dollar
   * VaR + market value already encode the same information.
   */
  var95Pct?: number;
  /** 1-day 95% expected shortfall as a return fraction (reference rows only). */
  cvar95Pct?: number;
  vol21Spark: number[];
  vol63Spark: number[];
  vol126Spark: number[];
  sharpe21Spark: number[];
  sharpe63Spark: number[];
  sharpe126Spark: number[];
  beta: number;
}

export interface PortfolioRisk {
  /** Annualized volatility using the most recent 252 trading days (1 year). */
  volatility1y: number;
  /**
   * Annualized volatility using all available history, up to 1260 trading days
   * (5 years). Falls back to available data if fewer days exist.
   */
  volatility5y: number;
  /**
   * 1-day parametric VaR at 95% confidence.
   * Formula: NAV × σ_portfolio_daily × z₀.₉₅
   * Covariance matrix estimated from the 252-day (1Y) window.
   */
  varParametric95: number;
  varParametric99: number;
  /** 1-day historical VaR (5th percentile of actual daily P&L, 252-day window). */
  varHistorical95: number;
  varHistorical99: number;
  /** Expected Shortfall (CVaR): mean loss in worst 5% of days, 252-day window. */
  cvar95: number;
  /** Peak-to-trough drawdown over full available history (up to 5Y). */
  maxDrawdown: number;
  maxDrawdownDuration: number;
  currentDrawdown: number;
  /** R² of portfolio returns vs S&P 500. Requires SP500 in BenchmarkPriceHistory. */
  systematicShare: number;
  idiosyncraticShare: number;
  /** Stressed VaR with all pairwise correlations forced to 1. */
  stressedVar95: number;
  /** Dollar diversification benefit vs stressed VaR. */
  diversificationBenefit: number;
  totalValue: number;
}

export interface CorrelationPayload {
  tickers: string[];
  matrix: number[][];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch adjusted-close price history and convert to daily returns.
 * Requests windowDays + 1 prices to yield exactly windowDays returns.
 * If fewer prices exist in the DB, returns all available returns.
 */
async function getSecurityReturns(
  securityId: string,
  windowDays = 1260,
): Promise<number[]> {
  const rows = await db.priceHistory.findMany({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    take: windowDays + 1,
    select: { adjClose: true },
  });
  const prices = rows.reverse().map((r) => Number(r.adjClose));
  return dailyReturnsFromAdjustedCloses(prices);
}

type BenchmarkCode = "SP500" | "NASDAQ" | "DOW";

/**
 * Fetch a benchmark's daily returns plus its latest index level (adjClose).
 * Returns `{ returns: [], lastPrice: 0 }` if the benchmark row or its price
 * history is missing — for SP500 this correctly drives vol decomposition to
 * 100% idiosyncratic, signalling that a data refresh is needed.
 */
async function getBenchmarkReturns(
  code: BenchmarkCode,
  windowDays = 1260,
): Promise<{ returns: number[]; lastPrice: number }> {
  const bench = await db.benchmark.findUnique({ where: { code } });
  if (!bench) return { returns: [], lastPrice: 0 };
  const rows = await db.benchmarkPriceHistory.findMany({
    where: { benchmarkId: bench.id },
    orderBy: { tradeDate: "desc" },
    take: windowDays + 1,
    select: { adjClose: true },
  });
  const ordered = rows.reverse().map((r) => Number(r.adjClose));
  return {
    returns: dailyReturnsFromAdjustedCloses(ordered),
    lastPrice: ordered.length ? ordered[ordered.length - 1]! : 0,
  };
}

/**
 * SP500 daily returns — used for position/portfolio beta. Thin wrapper over
 * getBenchmarkReturns preserving the prior call-site contract.
 */
async function getMarketReturns(windowDays = 1260): Promise<number[]> {
  return (await getBenchmarkReturns("SP500", windowDays)).returns;
}

const BENCHMARK_LABELS: { code: BenchmarkCode; label: string }[] = [
  { code: "SP500", label: "S&P 500" },
  { code: "NASDAQ", label: "NASDAQ" },
  { code: "DOW", label: "Dow" },
];

/**
 * Build a notional-free risk row for an index benchmark, mirroring the
 * per-position metric block. Dollar/notional fields stay 0 (rendered blank);
 * VaR/CVaR are expressed as return fractions via var95Pct/cvar95Pct.
 */
async function buildBenchmarkRiskRow(
  code: BenchmarkCode,
  label: string,
  windowDays = 504,
): Promise<PositionRisk | null> {
  const { returns: returns504, lastPrice } = await getBenchmarkReturns(code, windowDays);
  if (returns504.length < 2) return null;

  const annualRf = riskFreeAnnual();
  const returns252 = returns504.slice(-252);
  const returns126 = returns504.slice(-126);
  const returns63 = returns504.slice(-63);
  const returns21 = returns504.slice(-21);

  const vol252 = annualizedRealizedVolatility(returns252) ?? 0;
  const vol126 = annualizedRealizedVolatility(returns126) ?? 0;
  const vol63 = annualizedRealizedVolatility(returns63) ?? 0;
  const vol21 = annualizedRealizedVolatility(returns21) ?? 0;

  const sharpe21 = sharpeRatio(returns21, annualRf) ?? 0;
  const sharpe63 = sharpeRatio(returns63, annualRf) ?? 0;
  const sharpe126 = sharpeRatio(returns126, annualRf) ?? 0;

  const dailyVol252 = vol252 / Math.sqrt(252);
  const var95Pct = Z_95 * dailyVol252;
  const cvar95Pct = Math.abs(expectedShortfall(returns252, 0.05));

  return {
    ticker: label,
    name: label,
    weight: 0,
    isShort: false,
    marketValue: 0,
    lastPrice,
    varDollar95: 0,
    varDollar99: 0,
    marginalVar: 0,
    componentVar: 0,
    vol21d: vol21,
    vol63d: vol63,
    vol126d: vol126,
    vol252d: vol252,
    sharpe21d: sharpe21,
    sharpe63d: sharpe63,
    sharpe126d: sharpe126,
    cvar95: 0,
    var95Pct,
    cvar95Pct,
    vol21Spark: rollingVolSparkline(returns504, 21),
    vol63Spark: rollingVolSparkline(returns504, 63),
    vol126Spark: rollingVolSparkline(returns504, 126),
    sharpe21Spark: rollingSharpeSparkline(returns504, 21, annualRf),
    sharpe63Spark: rollingSharpeSparkline(returns504, 63, annualRf),
    sharpe126Spark: rollingSharpeSparkline(returns504, 126, annualRf),
    beta: 0,
  };
}

async function buildBenchmarkRiskRows(windowDays = 504): Promise<PositionRisk[]> {
  const rows = await Promise.all(
    BENCHMARK_LABELS.map(({ code, label }) =>
      buildBenchmarkRiskRow(code, label, windowDays),
    ),
  );
  return rows.filter((r): r is PositionRisk => r !== null);
}

type PortfolioPositionRow = {
  securityId: string | null;
  shares: unknown;
  isShort: boolean;
  isCash: boolean;
  cashAmount?: unknown;
  security?: { ticker: string; name: string; sector?: string | null } | null;
};

interface PortfolioReturnBundle {
  weights: number[];
  totalValue: number;
  aligned: number[][];
  portReturns: number[];
}

/**
 * Signed-weight portfolio return series aligned to the shortest constituent history.
 */
async function loadPortfolioReturnBundle(
  positions: PortfolioPositionRow[],
  windowDays: number,
): Promise<PortfolioReturnBundle | null> {
  if (!positions.length) return null;

  const equityPositions = positions.filter((p) => !p.isCash && p.securityId);
  const returnBySecId = new Map<string, number[]>();
  await Promise.all(
    equityPositions.map(async (p) => {
      returnBySecId.set(p.securityId!, await getSecurityReturns(p.securityId!, windowDays));
    }),
  );

  const equityLengths = equityPositions.map((p) => returnBySecId.get(p.securityId!)!.length);
  const minLen = equityLengths.length ? Math.min(...equityLengths) : 0;
  if (minLen === 0) return null;

  const lastPrices = await Promise.all(
    equityPositions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId! },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  const grossValues: number[] = [];
  const aligned: number[][] = [];
  let equityIdx = 0;

  for (const p of positions) {
    if (p.isCash) {
      const cashAmount = p.cashAmount != null ? Number(p.cashAmount) : 0;
      grossValues.push(cashAmount);
      aligned.push(Array(minLen).fill(0));
      continue;
    }
    const price = lastPrices[equityIdx] ? Number(lastPrices[equityIdx]!.adjClose) : 0;
    grossValues.push(Math.abs(Number(p.shares) * price));
    aligned.push(returnBySecId.get(p.securityId!)!.slice(-minLen));
    equityIdx++;
  }

  const totalValue = grossValues.reduce((s, v) => s + v, 0);
  const weights = positions.map((p, i) => {
    const gross = totalValue > 0 ? grossValues[i]! / totalValue : 0;
    return p.isCash ? gross : (p.isShort ? -1 : 1) * gross;
  });

  const portReturns = aligned[0]!.map((_, t) =>
    weights.reduce((s, w, i) => s + w * (aligned[i]![t] ?? 0), 0),
  );

  return { weights, totalValue, aligned, portReturns };
}

async function buildPortfolioTotalRisk(
  bundle: PortfolioReturnBundle,
): Promise<PositionRisk> {
  const { weights, totalValue, aligned, portReturns } = bundle;
  const annualRf = riskFreeAnnual();

  const returns252 = portReturns.slice(-252);
  const returns126 = portReturns.slice(-126);
  const returns63 = portReturns.slice(-63);
  const returns21 = portReturns.slice(-21);

  const vol252 = annualizedRealizedVolatility(returns252) ?? 0;
  const vol126 = annualizedRealizedVolatility(returns126) ?? 0;
  const vol63 = annualizedRealizedVolatility(returns63) ?? 0;
  const vol21 = annualizedRealizedVolatility(returns21) ?? 0;

  const sharpe21 = sharpeRatio(returns21, annualRf) ?? 0;
  const sharpe63 = sharpeRatio(returns63, annualRf) ?? 0;
  const sharpe126 = sharpeRatio(returns126, annualRf) ?? 0;

  const win1y = Math.min(252, portReturns.length);
  const aligned1y = aligned.map((r) => r.slice(-win1y));
  const individualVols = aligned1y.map((r) => annualizedRealizedVolatility(r) ?? 0);
  const corrMat = correlationMatrix(aligned1y);

  const var95 = portfolioParametricVaR(weights, corrMat, individualVols, totalValue, Z_95);
  const var99 = portfolioParametricVaR(weights, corrMat, individualVols, totalValue, Z_99);

  const dailyPnl1y = portReturns.slice(-win1y).map((r) => r * totalValue);
  const cvar95 = Math.abs(expectedShortfall(dailyPnl1y, 0.05));

  const mktReturns = await getMarketReturns(252);
  const { beta: rawBeta } = ols(returns252, mktReturns.slice(-returns252.length));
  const beta = vasicekBeta(rawBeta);

  return {
    ticker: "TOTAL",
    name: "Total Portfolio",
    weight: 1,
    isShort: false,
    marketValue: totalValue,
    lastPrice: 0,
    varDollar95: var95,
    varDollar99: var99,
    marginalVar: 0,
    componentVar: 0,
    vol21d: vol21,
    vol63d: vol63,
    vol126d: vol126,
    vol252d: vol252,
    sharpe21d: sharpe21,
    sharpe63d: sharpe63,
    sharpe126d: sharpe126,
    cvar95,
    vol21Spark: rollingVolSparkline(portReturns, 21),
    vol63Spark: rollingVolSparkline(portReturns, 63),
    vol126Spark: rollingVolSparkline(portReturns, 126),
    sharpe21Spark: rollingSharpeSparkline(portReturns, 21, annualRf),
    sharpe63Spark: rollingSharpeSparkline(portReturns, 63, annualRf),
    sharpe126Spark: rollingSharpeSparkline(portReturns, 126, annualRf),
    beta,
  };
}

export async function computePositionRisk(
  portfolioId: string,
): Promise<{
  positions: PositionRisk[];
  portfolioValue: number;
  portfolioTotal: PositionRisk | null;
  benchmarks: PositionRisk[];
}> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });

  if (!positions.length) {
    return {
      positions: [],
      portfolioValue: 0,
      portfolioTotal: null,
      benchmarks: await buildBenchmarkRiskRows(504),
    };
  }

  const equityPositions = positions.filter((p) => !p.isCash && p.securityId);
  const lastPrices = await Promise.all(
    equityPositions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId! },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  let equityIdx = 0;
  const posValues = positions.map((p) => {
    if (p.isCash) {
      const cashAmount = p.cashAmount != null ? Number(p.cashAmount) : 0;
      return {
        secId: null as string | null,
        ticker: "CASH",
        name: "Cash",
        shares: 0,
        isShort: false,
        isCash: true,
        lastPrice: 1,
        marketValue: cashAmount,
      };
    }
    const lastPrice = lastPrices[equityIdx]
      ? Number(lastPrices[equityIdx]!.adjClose)
      : 0;
    equityIdx++;
    return {
      secId: p.securityId,
      ticker: p.security!.ticker,
      name: p.security!.name,
      shares: Number(p.shares),
      isShort: p.isShort,
      isCash: false,
      lastPrice,
      marketValue: 0,
    };
  });
  // marketValue is gross (always positive) — total portfolio value is the
  // gross capital deployed, used as the dollar base for VaR scaling.
  posValues.forEach((pv) => {
    pv.marketValue = Math.abs(pv.shares * pv.lastPrice);
  });
  const totalValue = posValues.reduce((s, pv) => s + pv.marketValue, 0);

  const mktReturns = await getMarketReturns(252);
  const annualRf = riskFreeAnnual();

  const positionRisks: PositionRisk[] = [];

  for (const pv of posValues) {
    if (pv.isCash) {
      const weight = totalValue > 0 ? pv.marketValue / totalValue : 0;
      positionRisks.push({
        ticker: pv.ticker,
        name: pv.name,
        weight,
        isShort: false,
        marketValue: pv.marketValue,
        lastPrice: 1,
        varDollar95: 0,
        varDollar99: 0,
        marginalVar: 0,
        componentVar: 0,
        vol21d: 0,
        vol63d: 0,
        vol126d: 0,
        vol252d: 0,
        sharpe21d: 0,
        sharpe63d: 0,
        sharpe126d: 0,
        cvar95: 0,
        vol21Spark: [],
        vol63Spark: [],
        vol126Spark: [],
        sharpe21Spark: [],
        sharpe63Spark: [],
        sharpe126Spark: [],
        beta: 0,
      });
      continue;
    }

    const returns504 = await getSecurityReturns(pv.secId!, 504);
    const returns252 = returns504.slice(-252);
    const returns126 = returns504.slice(-126);
    const returns63 = returns504.slice(-63);
    const returns21 = returns504.slice(-21);

    const vol252 = annualizedRealizedVolatility(returns252) ?? 0;
    const vol126 = annualizedRealizedVolatility(returns126) ?? 0;
    const vol63 = annualizedRealizedVolatility(returns63) ?? 0;
    const vol21 = annualizedRealizedVolatility(returns21) ?? 0;

    const sharpe21 = sharpeRatio(returns21, annualRf) ?? 0;
    const sharpe63 = sharpeRatio(returns63, annualRf) ?? 0;
    const sharpe126 = sharpeRatio(returns126, annualRf) ?? 0;

    const weight = totalValue > 0 ? pv.marketValue / totalValue : 0;

    const { beta: rawBeta } = ols(returns252, mktReturns.slice(-252));
    const beta = vasicekBeta(rawBeta);

    const var95 = parametricVaR(weight, totalValue, vol252, Z_95);
    const var99 = parametricVaR(weight, totalValue, vol252, Z_99);

    const dailyPnl252 = returns252.map((r) => r * pv.marketValue);
    const cvar95 = Math.abs(expectedShortfall(dailyPnl252, 0.05));

    positionRisks.push({
      ticker: pv.ticker,
      name: pv.name,
      weight,
      isShort: pv.isShort,
      marketValue: pv.marketValue,
      lastPrice: pv.lastPrice,
      varDollar95: var95,
      varDollar99: var99,
      marginalVar: 0,
      componentVar: 0,
      vol21d: vol21,
      vol63d: vol63,
      vol126d: vol126,
      vol252d: vol252,
      sharpe21d: sharpe21,
      sharpe63d: sharpe63,
      sharpe126d: sharpe126,
      cvar95,
      vol21Spark: rollingVolSparkline(returns504, 21),
      vol63Spark: rollingVolSparkline(returns504, 63),
      vol126Spark: rollingVolSparkline(returns504, 126),
      sharpe21Spark: rollingSharpeSparkline(returns504, 21, annualRf),
      sharpe63Spark: rollingSharpeSparkline(returns504, 63, annualRf),
      sharpe126Spark: rollingSharpeSparkline(returns504, 126, annualRf),
      beta,
    });
  }

  const bundle504 = await loadPortfolioReturnBundle(positions, 504);
  const portfolioTotal = bundle504 ? await buildPortfolioTotalRisk(bundle504) : null;
  const benchmarks = await buildBenchmarkRiskRows(504);

  return {
    positions: positionRisks,
    portfolioValue: totalValue,
    portfolioTotal,
    benchmarks,
  };
}

export async function computePortfolioRisk(
  portfolioId: string,
): Promise<PortfolioRisk | null> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });
  if (!positions.length) return null;

  const bundle = await loadPortfolioReturnBundle(positions, 1260);
  if (!bundle) return null;

  const { weights, totalValue, aligned, portReturns } = bundle;

  // ── Volatility ──────────────────────────────────────────────────────────
  // vol5y: annualized vol over the full available window (up to 1260 days).
  // vol1y: annualized vol over the most recent 252 trading days only.
  const vol5y = annualizedRealizedVolatility(portReturns) ?? 0;
  const vol1y = annualizedRealizedVolatility(portReturns.slice(-252)) ?? 0;

  // ── VaR — uses 1Y (252-day) covariance matrix ───────────────────────────
  // Industry standard: use a 1-year lookback for the variance estimate so that
  // VaR reflects the current market regime rather than distant history.
  const win1y = Math.min(252, portReturns.length);
  const aligned1y = aligned.map((r) => r.slice(-win1y));
  const individualVols = aligned1y.map((r) => annualizedRealizedVolatility(r) ?? 0);
  const corrMat = correlationMatrix(aligned1y);

  const varP95 = portfolioParametricVaR(weights, corrMat, individualVols, totalValue, Z_95);
  const varP99 = portfolioParametricVaR(weights, corrMat, individualVols, totalValue, Z_99);

  const dailyPnl1y = portReturns.slice(-win1y).map((r) => r * totalValue);
  const varH95 = Math.abs(historicalVaR(dailyPnl1y, 0.05));
  const varH99 = Math.abs(historicalVaR(dailyPnl1y, 0.01));
  const cvar95 = Math.abs(expectedShortfall(dailyPnl1y, 0.05));

  const stressed95 = stressedVaR(weights, individualVols, totalValue, Z_95);
  const divBenefit = stressed95 - varP95;

  // ── Drawdown — uses full available history (up to 5Y) ───────────────────
  const mdd = maxDrawdown(portReturns);
  const mddDur = maxDrawdownDuration(portReturns);
  const curDD = currentDrawdown(portReturns);

  // ── Volatility decomposition vs S&P 500 ─────────────────────────────────
  // If BenchmarkPriceHistory is empty (no data refresh run yet), getMarketReturns
  // returns [] and OLS returns rSquared=0, so idiosyncraticShare=1. Run a data
  // refresh to populate the benchmark and get real decomposition.
  const minLen = portReturns.length;
  const mktReturns = await getMarketReturns(minLen);
  const mktAligned = mktReturns.slice(-minLen);
  const { systematicShare, idiosyncraticShare } = volDecomposition(portReturns, mktAligned);

  return {
    volatility1y: vol1y,
    volatility5y: vol5y,
    varParametric95: varP95,
    varParametric99: varP99,
    varHistorical95: varH95,
    varHistorical99: varH99,
    cvar95,
    maxDrawdown: mdd,
    maxDrawdownDuration: mddDur,
    currentDrawdown: curDD,
    systematicShare,
    idiosyncraticShare,
    stressedVar95: stressed95,
    diversificationBenefit: divBenefit,
    totalValue,
  };
}

export async function computeCorrelationMatrix(
  portfolioId: string,
): Promise<CorrelationPayload> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, isCash: false, securityId: { not: null } },
    include: { security: true },
    distinct: ["securityId"],
  });

  if (!positions.length) return { tickers: [], matrix: [] };

  const returnSeries = await Promise.all(
    positions.map((p) => getSecurityReturns(p.securityId!, 252)),
  );
  const tickers = positions.map((p) => p.security!.ticker);

  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));

  const matrix = correlationMatrix(aligned);
  return { tickers, matrix };
}

export async function computePortfolioRiskSeries(
  portfolioId: string,
): Promise<{ dates: string[]; drawdown: number[]; rollingVol252: number[] }> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });
  if (!positions.length) return { dates: [], drawdown: [], rollingVol252: [] };

  const bundle = await loadPortfolioReturnBundle(positions, 1260);
  if (!bundle) return { dates: [], drawdown: [], rollingVol252: [] };

  const { portReturns } = bundle;
  const firstEquity = positions.find((p) => !p.isCash && p.securityId);
  if (!firstEquity) return { dates: [], drawdown: [], rollingVol252: [] };

  const priceRows = await db.priceHistory.findMany({
    where: { securityId: firstEquity.securityId! },
    orderBy: { tradeDate: "desc" },
    take: portReturns.length + 1,
    select: { tradeDate: true },
  });
  const dates = priceRows.reverse().slice(1).map((r) => r.tradeDate.toISOString().slice(0, 10));

  const dd = drawdownSeries(portReturns);

  const rollingVol: number[] = new Array(portReturns.length).fill(NaN);
  for (let i = 252; i <= portReturns.length; i++) {
    rollingVol[i - 1] = annualizedRealizedVolatility(portReturns.slice(i - 252, i)) ?? NaN;
  }

  return { dates, drawdown: dd, rollingVol252: rollingVol };
}
