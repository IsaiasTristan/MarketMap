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

// ── Types ──────────────────────────────────────────────────────────────────

export interface PositionRisk {
  ticker: string;
  name: string;
  weight: number;
  marketValue: number;
  varDollar95: number;
  varDollar99: number;
  marginalVar: number;
  componentVar: number;
  vol21d: number;
  vol63d: number;
  vol252d: number;
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

/**
 * Fetch SP500 benchmark daily returns.
 * Returns [] if the SP500 benchmark row or its price history is missing —
 * in that case vol decomposition correctly falls back to 100% idiosyncratic,
 * which signals that a data refresh is needed.
 */
async function getMarketReturns(windowDays = 1260): Promise<number[]> {
  const bench = await db.benchmark.findUnique({ where: { code: "SP500" } });
  if (!bench) return [];
  const rows = await db.benchmarkPriceHistory.findMany({
    where: { benchmarkId: bench.id },
    orderBy: { tradeDate: "desc" },
    take: windowDays + 1,
    select: { adjClose: true },
  });
  return dailyReturnsFromAdjustedCloses(rows.reverse().map((r) => Number(r.adjClose)));
}

function returnsToNWindow(returns: number[], n: number): number[] {
  return returns.slice(-n);
}

// ── Main exports ───────────────────────────────────────────────────────────

export async function computePositionRisk(
  portfolioId: string,
): Promise<{ positions: PositionRisk[]; portfolioValue: number }> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });

  if (!positions.length) return { positions: [], portfolioValue: 0 };

  const secIds = positions.map((p) => p.securityId);
  const lastPrices = await Promise.all(
    secIds.map((id) =>
      db.priceHistory.findFirst({
        where: { securityId: id },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  const posValues = positions.map((p, i) => ({
    secId: p.securityId,
    ticker: p.security.ticker,
    name: p.security.name,
    shares: Number(p.shares),
    lastPrice: lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice),
    marketValue: 0,
  }));
  posValues.forEach((pv) => {
    pv.marketValue = pv.shares * pv.lastPrice;
  });
  const totalValue = posValues.reduce((s, pv) => s + pv.marketValue, 0);

  const mktReturns = await getMarketReturns(252);

  const positionRisks: PositionRisk[] = [];

  for (const pv of posValues) {
    // Position-level risk still uses 252-day window for the per-column vol display
    const returns252 = await getSecurityReturns(pv.secId, 252);
    const returns63 = returnsToNWindow(returns252, 63);
    const returns21 = returnsToNWindow(returns252, 21);

    const vol252 = annualizedRealizedVolatility(returns252) ?? 0;
    const vol63 = annualizedRealizedVolatility(returns63) ?? 0;
    const vol21 = annualizedRealizedVolatility(returns21) ?? 0;

    const weight = totalValue > 0 ? pv.marketValue / totalValue : 0;

    const { beta: rawBeta } = ols(returns252, mktReturns.slice(-252));
    const beta = vasicekBeta(rawBeta);

    const var95 = parametricVaR(weight, totalValue, vol252, Z_95);
    const var99 = parametricVaR(weight, totalValue, vol252, Z_99);

    positionRisks.push({
      ticker: pv.ticker,
      name: pv.name,
      weight,
      marketValue: pv.marketValue,
      varDollar95: var95,
      varDollar99: var99,
      marginalVar: 0,
      componentVar: 0,
      vol21d: vol21,
      vol63d: vol63,
      vol252d: vol252,
      beta,
    });
  }

  return { positions: positionRisks, portfolioValue: totalValue };
}

export async function computePortfolioRisk(
  portfolioId: string,
): Promise<PortfolioRisk | null> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return null;

  const secIds = positions.map((p) => p.securityId);

  // Fetch up to 5Y (1260 days) of return history per security.
  const returnSeries = await Promise.all(
    secIds.map((id) => getSecurityReturns(id, 1260)),
  );

  const lastPrices = await Promise.all(
    secIds.map((id) =>
      db.priceHistory.findFirst({
        where: { securityId: id },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );
  const values = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = values.reduce((s, v) => s + v, 0);
  const weights = values.map((v) => (totalValue > 0 ? v / totalValue : 0));

  // Align all return series to the shortest available — typically limited by
  // the newest position or any security with limited price history.
  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));

  // Weighted portfolio return series (full available history, up to 5Y).
  const portReturns = aligned[0].map((_, t) =>
    weights.reduce((s, w, i) => s + w * (aligned[i][t] ?? 0), 0),
  );

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
    where: { portfolioId, closedAt: null },
    include: { security: true },
    distinct: ["securityId"],
  });

  // Correlation matrix uses 252-day window (1Y) — same as VaR.
  const returnSeries = await Promise.all(
    positions.map((p) => getSecurityReturns(p.securityId, 252)),
  );
  const tickers = positions.map((p) => p.security.ticker);

  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));

  const matrix = correlationMatrix(aligned);
  return { tickers, matrix };
}

export async function computePortfolioRiskSeries(
  portfolioId: string,
): Promise<{ dates: string[]; drawdown: number[]; rollingVol252: number[] }> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return { dates: [], drawdown: [], rollingVol252: [] };

  const secIds = positions.map((p) => p.securityId);

  // Fetch full 5Y window so the drawdown chart covers the same horizon as vol5y.
  const returnSeries = await Promise.all(
    secIds.map((id) => getSecurityReturns(id, 1260)),
  );
  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));

  const lastPrices = await Promise.all(
    secIds.map((id) =>
      db.priceHistory.findFirst({ where: { securityId: id }, orderBy: { tradeDate: "desc" }, select: { adjClose: true } }),
    ),
  );
  const values = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = values.reduce((s, v) => s + v, 0);
  const weights = values.map((v) => (totalValue > 0 ? v / totalValue : 0));

  const portReturns = aligned[0].map((_, t) =>
    weights.reduce((s, w, i) => s + w * (aligned[i][t] ?? 0), 0),
  );

  // Dates: pull from the first security's price history, matching the aligned window.
  const priceRows = await db.priceHistory.findMany({
    where: { securityId: secIds[0] },
    orderBy: { tradeDate: "desc" },
    take: minLen + 1,
    select: { tradeDate: true },
  });
  const dates = priceRows.reverse().slice(1).map((r) => r.tradeDate.toISOString().slice(0, 10));

  const dd = drawdownSeries(portReturns);

  // Rolling 252-day vol: starts producing values at day 252.
  const rollingVol: number[] = new Array(portReturns.length).fill(NaN);
  for (let i = 252; i <= portReturns.length; i++) {
    rollingVol[i - 1] = annualizedRealizedVolatility(portReturns.slice(i - 252, i)) ?? NaN;
  }

  return { dates, drawdown: dd, rollingVol252: rollingVol };
}
