/**
 * stress.service — historical scenario replay, custom shocks, factor shocks,
 * and correlation stress testing.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { vasicekBeta, ols } from "@/domain/calculations/beta";
import {
  stressedVaR,
  portfolioParametricVaR,
  Z_95,
} from "@/domain/calculations/var";
import { annualizedRealizedVolatility } from "@/domain/calculations/volatility";
import { correlationMatrix } from "@/domain/calculations/correlation";

// ── Historical scenario library ────────────────────────────────────────────

export const HISTORICAL_SCENARIOS = [
  { key: "2008_crisis", name: "2008 Financial Crisis", start: "2008-09-01", end: "2008-11-30" },
  { key: "covid_crash", name: "COVID Crash", start: "2020-02-19", end: "2020-03-23" },
  { key: "2022_rate_shock", name: "2022 Rate Shock", start: "2022-01-01", end: "2022-12-31" },
  { key: "dotcom_crash", name: "Dot-Com Crash", start: "2000-03-01", end: "2002-10-09" },
  { key: "quant_quake", name: "Quant Quake", start: "2007-08-01", end: "2007-08-31" },
];

export interface ScenarioResult {
  key: string;
  name: string;
  start: string;
  end: string;
  estimatedPnlDollar: number;
  estimatedPnlPct: number;
  worstPositions: { ticker: string; estimatedPnl: number }[];
  worstCaseDrawdown: number;
}

export interface CustomShockInput {
  spxChange?: number; // decimal e.g. -0.20 = -20%
  rateChangeBps?: number; // basis points
  vixChange?: number; // absolute points
  sectorOverrides?: Record<string, number>; // sector → decimal change
}

export interface ShockResult {
  estimatedPnlDollar: number;
  estimatedPnlPct: number;
  positionImpacts: { ticker: string; sector: string | null; estimatedPnl: number }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getMarketReturnsDuring(
  start: string,
  end: string,
): Promise<{ spy: number; totalReturn: number }> {
  const bench = await db.benchmark.findUnique({ where: { code: "SP500" } });
  if (!bench) return { spy: -0.1, totalReturn: -0.1 };

  const prices = await db.benchmarkPriceHistory.findMany({
    where: {
      benchmarkId: bench.id,
      tradeDate: { gte: new Date(start), lte: new Date(end) },
    },
    orderBy: { tradeDate: "asc" },
    select: { adjClose: true },
  });

  if (prices.length < 2) return { spy: -0.1, totalReturn: -0.1 };
  const first = Number(prices[0].adjClose);
  const last = Number(prices[prices.length - 1].adjClose);
  const totalReturn = (last - first) / first;
  return { spy: totalReturn, totalReturn };
}

// ── Historical scenario replay ─────────────────────────────────────────────

export async function runHistoricalScenarios(
  portfolioId: string,
): Promise<ScenarioResult[]> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return [];

  // Get last prices + weights
  const lastPrices = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true, securityId: true },
      }),
    ),
  );

  const marketValues = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = marketValues.reduce((s, v) => s + v, 0);
  const weights = marketValues.map((v) => (totalValue > 0 ? v / totalValue : 0));

  // Get betas vs market
  const mktBench = await db.benchmark.findUnique({ where: { code: "SP500" } });
  const mktPrices = mktBench
    ? await db.benchmarkPriceHistory.findMany({
        where: { benchmarkId: mktBench.id },
        orderBy: { tradeDate: "desc" },
        take: 253,
        select: { adjClose: true },
      })
    : [];
  const mktReturns = dailyReturnsFromAdjustedCloses(mktPrices.reverse().map((r) => Number(r.adjClose)));

  const betas = await Promise.all(
    positions.map(async (p, i) => {
      const ph = await db.priceHistory.findMany({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        take: 253,
        select: { adjClose: true },
      });
      const rets = dailyReturnsFromAdjustedCloses(ph.reverse().map((r) => Number(r.adjClose)));
      const n = Math.min(rets.length, mktReturns.length);
      const { beta } = ols(rets.slice(-n), mktReturns.slice(-n));
      return vasicekBeta(beta);
    }),
  );

  const results: ScenarioResult[] = [];

  for (const scenario of HISTORICAL_SCENARIOS) {
    const { spy } = await getMarketReturnsDuring(scenario.start, scenario.end);

    const positionPnls = positions.map((p, i) => {
      const betaScaled = spy * betas[i];
      const impact = betaScaled * marketValues[i];
      return { ticker: p.security.ticker, estimatedPnl: impact };
    });

    const totalPnl = positionPnls.reduce((s, p) => s + p.estimatedPnl, 0);
    const worstPositions = [...positionPnls].sort((a, b) => a.estimatedPnl - b.estimatedPnl).slice(0, 5);

    results.push({
      ...scenario,
      estimatedPnlDollar: totalPnl,
      estimatedPnlPct: totalValue > 0 ? totalPnl / totalValue : 0,
      worstPositions,
      worstCaseDrawdown: Math.min(spy, -0.05),
    });
  }

  return results;
}

// ── Custom shock ───────────────────────────────────────────────────────────

const RATE_SENSITIVE_SECTORS = new Set(["Financials", "Utilities", "Real Estate"]);

export async function runCustomShock(
  portfolioId: string,
  shock: CustomShockInput,
): Promise<ShockResult> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return { estimatedPnlDollar: 0, estimatedPnlPct: 0, positionImpacts: [] };

  const lastPrices = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  const marketValues = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = marketValues.reduce((s, v) => s + v, 0);

  const mktBench = await db.benchmark.findUnique({ where: { code: "SP500" } });
  const mktPrices = mktBench
    ? await db.benchmarkPriceHistory.findMany({
        where: { benchmarkId: mktBench.id },
        orderBy: { tradeDate: "desc" },
        take: 253,
        select: { adjClose: true },
      })
    : [];
  const mktReturns = dailyReturnsFromAdjustedCloses(mktPrices.reverse().map((r) => Number(r.adjClose)));

  const positionImpacts = await Promise.all(
    positions.map(async (p, i) => {
      const ph = await db.priceHistory.findMany({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        take: 253,
        select: { adjClose: true },
      });
      const rets = dailyReturnsFromAdjustedCloses(ph.reverse().map((r) => Number(r.adjClose)));
      const n = Math.min(rets.length, mktReturns.length);
      const { beta } = ols(rets.slice(-n), mktReturns.slice(-n));
      const adjBeta = vasicekBeta(beta);

      const sector = p.sector ?? p.security.sector ?? "Other";

      // SPX shock (via beta)
      let totalReturn = (shock.spxChange ?? 0) * adjBeta;

      // Rate shock for rate-sensitive sectors
      if (shock.rateChangeBps && RATE_SENSITIVE_SECTORS.has(sector)) {
        totalReturn += -(shock.rateChangeBps / 10000) * 5; // approximate duration sensitivity
      }

      // Sector override
      if (shock.sectorOverrides?.[sector] !== undefined) {
        totalReturn += shock.sectorOverrides[sector];
      }

      const estimatedPnl = totalReturn * marketValues[i];
      return { ticker: p.security.ticker, sector, estimatedPnl };
    }),
  );

  const totalPnl = positionImpacts.reduce((s, p) => s + p.estimatedPnl, 0);

  return {
    estimatedPnlDollar: totalPnl,
    estimatedPnlPct: totalValue > 0 ? totalPnl / totalValue : 0,
    positionImpacts: positionImpacts.sort((a, b) => a.estimatedPnl - b.estimatedPnl),
  };
}

// ── Correlation stress test ────────────────────────────────────────────────

export async function runCorrelationStress(
  portfolioId: string,
): Promise<{
  normalVar95: number;
  stressedVar95: number;
  diversificationBenefit: number;
  totalValue: number;
}> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return { normalVar95: 0, stressedVar95: 0, diversificationBenefit: 0, totalValue: 0 };

  const lastPrices = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      }),
    ),
  );

  const marketValues = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = marketValues.reduce((s, v) => s + v, 0);
  const weights = marketValues.map((v) => (totalValue > 0 ? v / totalValue : 0));

  const returnSeries = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findMany({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        take: 253,
        select: { adjClose: true },
      }).then((rows) => dailyReturnsFromAdjustedCloses(rows.reverse().map((r) => Number(r.adjClose)))),
    ),
  );

  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));
  const vols = aligned.map((r) => annualizedRealizedVolatility(r) ?? 0);
  const corrMat = correlationMatrix(aligned);

  const normalVar = portfolioParametricVaR(weights, corrMat, vols, totalValue, Z_95);
  const stressed = stressedVaR(weights, vols, totalValue, Z_95);

  return {
    normalVar95: normalVar,
    stressedVar95: stressed,
    diversificationBenefit: stressed - normalVar,
    totalValue,
  };
}
