/**
 * factor.service — factor exposure scoring for Module 3.
 * Z-scores are computed within the portfolio universe (not full S&P 500,
 * which requires fundamentals for all 500+ stocks; see phase3-fundamentals).
 * This service uses the portfolio positions as the universe for scoring.
 */

import { prisma as db } from "@/infrastructure/db/client";
import {
  zScore,
  winsorize,
  compositeScore,
  portfolioExposure,
  momentum12m1,
} from "@/domain/calculations/factor-scoring";
import { vasicekBeta, ols } from "@/domain/calculations/beta";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { annualizedRealizedVolatility } from "@/domain/calculations/volatility";
import { fetchYahooFundamentals } from "@/infrastructure/providers/yahoo-fundamentals";

export interface FactorExposures {
  tickers: string[];
  weights: number[];
  marketBeta: number;
  sizeFactor: number;
  valueFactor: number;
  momentumFactor: number;
  qualityFactor: number;
  lowVolFactor: number;
  sectorExposure: Record<string, number>;
  perPosition: PerPositionFactor[];
  toleranceBand: number;
  /** False when no SecurityFundamentals rows exist for these positions. */
  hasFundamentals: boolean;
}

export interface PerPositionFactor {
  ticker: string;
  weight: number;
  beta: number;
  sizeZScore: number;
  valueZScore: number;
  momentumZScore: number;
  qualityZScore: number;
  volZScore: number;
}

export async function computeFactorExposures(
  portfolioId: string,
): Promise<FactorExposures | null> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return null;

  // Get prices + fundamentals
  const secIds = positions.map((p) => p.securityId);

  const [lastPrices, fundamentals, benchPrices] = await Promise.all([
    Promise.all(
      secIds.map((id) =>
        db.priceHistory.findMany({
          where: { securityId: id },
          orderBy: { tradeDate: "desc" },
          take: 253,
          select: { adjClose: true, tradeDate: true },
        }),
      ),
    ),
    Promise.all(
      secIds.map((id) =>
        db.securityFundamentals.findFirst({
          where: { securityId: id },
          orderBy: { asOfDate: "desc" },
        }),
      ),
    ),
    db.benchmark.findUnique({ where: { code: "SP500" } }).then((b) =>
      b
        ? db.benchmarkPriceHistory.findMany({
            where: { benchmarkId: b.id },
            orderBy: { tradeDate: "desc" },
            take: 253,
            select: { adjClose: true },
          })
        : [],
    ),
  ]);

  const mktPrices = benchPrices.reverse().map((r) => Number(r.adjClose));
  const mktReturns = dailyReturnsFromAdjustedCloses(mktPrices);

  // Compute values + weights
  const marketValues = positions.map((p, i) => {
    const price = lastPrices[i][0] ? Number(lastPrices[i][0].adjClose) : Number(p.entryPrice);
    return Number(p.shares) * price;
  });
  const totalValue = marketValues.reduce((s, v) => s + v, 0);
  const weights = marketValues.map((v) => (totalValue > 0 ? v / totalValue : 0));
  const tickers = positions.map((p) => p.security.ticker);

  // Beta per position
  const betas: number[] = [];
  const vols: number[] = [];
  const moms: number[] = [];

  for (let i = 0; i < positions.length; i++) {
    const priceHistory = lastPrices[i].reverse().map((r) => Number(r.adjClose));
    const returns = dailyReturnsFromAdjustedCloses(priceHistory);
    const n = Math.min(returns.length, mktReturns.length);
    const { beta } = ols(returns.slice(-n), mktReturns.slice(-n));
    betas.push(vasicekBeta(beta));
    vols.push(annualizedRealizedVolatility(returns.slice(-252)) ?? 0);
    moms.push(momentum12m1(priceHistory) ?? 0);
  }

  // Fundamentals-based factor scores
  const marketCaps = fundamentals.map((f) => (f?.marketCap ? Number(f.marketCap) : null));
  const bpRatios = fundamentals.map((f) => (f?.bookToPrice ? Number(f.bookToPrice) : null));
  const epRatios = fundamentals.map((f) => (f?.earningsToPrice ? Number(f.earningsToPrice) : null));
  const fcfYields = fundamentals.map((f) => (f?.fcfYield ? Number(f.fcfYield) : null));
  const roes = fundamentals.map((f) => (f?.roe ? Number(f.roe) : null));
  const grossMargins = fundamentals.map((f) => (f?.grossMargin ? Number(f.grossMargin) : null));
  const deRatios = fundamentals.map((f) => (f?.debtToEquity ? Number(f.debtToEquity) : null));

  // Fill nulls with median
  const fillNull = (arr: (number | null)[]): number[] => {
    const valid = arr.filter((v): v is number => v !== null);
    const med = valid.length ? valid.sort((a, b) => a - b)[Math.floor(valid.length / 2)] : 0;
    return arr.map((v) => (v !== null ? v : med));
  };

  const mcFilled = fillNull(marketCaps).map((v) => Math.log(Math.max(1, v)));
  const bpFilled = fillNull(bpRatios);
  const epFilled = fillNull(epRatios);
  const fcfFilled = fillNull(fcfYields);
  const roeFilled = fillNull(roes);
  const gmFilled = fillNull(grossMargins);
  const deFilled = fillNull(deRatios).map((v) => -v); // invert debt-to-equity

  const sizeZScores = zScore(winsorize(mcFilled));
  const valueZScores = compositeScore([bpFilled, epFilled, fcfFilled]);
  const momZScores = zScore(winsorize(moms));
  const qualityZScores = compositeScore([roeFilled, gmFilled, deFilled]);
  const volZScores = zScore(winsorize(vols));

  // Portfolio-level exposures
  const marketBeta = portfolioExposure(weights, betas);
  const sizeFactor = portfolioExposure(weights, sizeZScores);
  const valueFactor = portfolioExposure(weights, valueZScores);
  const momentumFactor = portfolioExposure(weights, momZScores);
  const qualityFactor = portfolioExposure(weights, qualityZScores);
  const lowVolFactor = portfolioExposure(weights, volZScores);

  // Sector exposures
  const sectorExposure: Record<string, number> = {};
  for (let i = 0; i < positions.length; i++) {
    const sector = positions[i].sector ?? positions[i].security.sector ?? "Other";
    sectorExposure[sector] = (sectorExposure[sector] ?? 0) + weights[i];
  }

  const perPosition: PerPositionFactor[] = tickers.map((t, i) => ({
    ticker: t,
    weight: weights[i],
    beta: betas[i],
    sizeZScore: sizeZScores[i] ?? 0,
    valueZScore: valueZScores[i] ?? 0,
    momentumZScore: momZScores[i] ?? 0,
    qualityZScore: qualityZScores[i] ?? 0,
    volZScore: volZScores[i] ?? 0,
  }));

  // Tolerance band from AppSetting or default
  const setting = await db.appSetting.findUnique({ where: { key: "factorToleranceBand" } });
  const toleranceBand = setting ? Number((setting.value as { band: number }).band ?? 0.5) : 0.5;

  return {
    tickers,
    weights,
    marketBeta,
    sizeFactor,
    valueFactor,
    momentumFactor,
    qualityFactor,
    lowVolFactor,
    sectorExposure,
    perPosition,
    toleranceBand,
    hasFundamentals: fundamentals.some((f) => f !== null),
  };
}

/**
 * Fetch fundamentals from Yahoo Finance for all open positions in a portfolio
 * and upsert into SecurityFundamentals. Skips tickers whose data was already
 * fetched today. Returns the number of securities refreshed.
 */
export async function refreshPortfolioFundamentals(portfolioId: string): Promise<number> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
    distinct: ["securityId"],
  });
  if (!positions.length) return 0;

  const today = new Date(new Date().toISOString().slice(0, 10));

  // Skip securities that already have a row for today
  const existing = await db.securityFundamentals.findMany({
    where: {
      securityId: { in: positions.map((p) => p.securityId) },
      asOfDate: today,
    },
    select: { securityId: true },
  });
  const alreadyFresh = new Set(existing.map((r) => r.securityId));
  const toRefresh = positions.filter((p) => !alreadyFresh.has(p.securityId));
  if (!toRefresh.length) return 0;

  const CONCURRENCY = 3;
  const DELAY_MS = 200;
  let refreshed = 0;

  for (let i = 0; i < toRefresh.length; i += CONCURRENCY) {
    const batch = toRefresh.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (pos) => {
        const data = await fetchYahooFundamentals(pos.security.ticker).catch(() => null);
        if (!data) return;
        const payload = {
          marketCap: data.marketCap ?? null,
          bookToPrice: data.bookToPrice ?? null,
          earningsToPrice: data.earningsToPrice ?? null,
          fcfYield: data.fcfYield ?? null,
          roe: data.roe ?? null,
          grossMargin: data.grossMargin ?? null,
          debtToEquity: data.debtToEquity ?? null,
          shortRatio: data.shortRatio ?? null,
        };
        await db.securityFundamentals.upsert({
          where: { securityId_asOfDate: { securityId: pos.securityId, asOfDate: today } },
          create: { securityId: pos.securityId, asOfDate: today, ...payload },
          update: payload,
        });
        refreshed++;
      }),
    );
    if (i + CONCURRENCY < toRefresh.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  return refreshed;
}
