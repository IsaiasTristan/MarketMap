import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { DateClose } from "@/domain/calculations/alignment";
import {
  dailyReturnVectorsFromMatrix,
  intersectAlignedCloses,
} from "@/domain/calculations/alignment";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import {
  annualizedPortVol,
  annualizedReturnFromPortDaily,
  portfolioDailyReturnSeries,
  portfolioSharpe,
  sumWeights,
} from "@/domain/calculations/portfolio";
import { riskFreeAnnual } from "@/infrastructure/config/env";

function dec(x: { toString(): string }): number {
  return Number(x.toString());
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function loadPrices(
  db: PrismaClient,
  securityId: string,
  take = 400
): Promise<DateClose[]> {
  const rows = await db.priceHistory.findMany({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    take,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

async function loadBenchmarkSeriesDb(
  db: PrismaClient,
  code: "SP500" | "NASDAQ" | "DOW"
): Promise<DateClose[]> {
  const b = await db.benchmark.findUnique({ where: { code } });
  if (!b) return [];
  const rows = await db.benchmarkPriceHistory.findMany({
    where: { benchmarkId: b.id },
    orderBy: { tradeDate: "desc" },
    take: 400,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

export async function listPortfolios(db: PrismaClient) {
  return db.portfolio.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { holdings: true } } },
  });
}

export async function getPortfolio(db: PrismaClient, id: string) {
  return db.portfolio.findUnique({
    where: { id },
    include: { holdings: { include: { security: true } } },
  });
}

export async function createPortfolio(db: PrismaClient, name: string) {
  return db.portfolio.create({ data: { name } });
}

export async function renamePortfolio(db: PrismaClient, id: string, name: string) {
  return db.portfolio.update({ where: { id }, data: { name } });
}

export async function deletePortfolio(db: PrismaClient, id: string) {
  await db.portfolio.delete({ where: { id } });
}

export async function replaceHoldings(
  db: PrismaClient,
  portfolioId: string,
  holdings: {
    ticker: string;
    weight: number;
    shares?: number | null;
    entryDate?: string | null;
    sector?: string | null;
  }[]
): Promise<void> {
  const wsum = sumWeights(holdings.map((h) => h.weight));
  if (Math.abs(wsum - 1) > 0.001) {
    throw new Error(`Weights must sum to 1 (got ${wsum.toFixed(4)})`);
  }
  await db.$transaction(async (tx) => {
    await tx.portfolioHolding.deleteMany({ where: { portfolioId } });
    for (const h of holdings) {
      const t = h.ticker.trim().toUpperCase();
      const sec = await tx.security.findUnique({ where: { ticker: t } });
      if (!sec) throw new Error(`Unknown ticker: ${t}`);
      await tx.portfolioHolding.create({
        data: {
          portfolioId,
          securityId: sec.id,
          weight: new Decimal(h.weight),
          shares: h.shares != null ? new Decimal(h.shares) : null,
          entryDate: h.entryDate ? new Date(h.entryDate) : null,
          sector: h.sector ?? null,
        },
      });
    }
  });
}

export async function computePortfolioAnalytics(
  db: PrismaClient,
  portfolioId: string,
  benchmarkCode: "SP500" | "NASDAQ" | "DOW" = "SP500"
): Promise<{
  daily: number[];
  annualizedReturn: number | null;
  annualizedVol: number | null;
  sharpe: number | null;
  benchmarkDaily: number[];
  benchmarkAnnReturn: number | null;
  benchmarkAnnVol: number | null;
  benchmarkSharpe: number | null;
}> {
  const empty = () => ({
    daily: [] as number[],
    annualizedReturn: null as number | null,
    annualizedVol: null as number | null,
    sharpe: null as number | null,
    benchmarkDaily: [] as number[],
    benchmarkAnnReturn: null as number | null,
    benchmarkAnnVol: null as number | null,
    benchmarkSharpe: null as number | null,
  });

  const p = await getPortfolio(db, portfolioId);
  if (!p || p.holdings.length === 0) return empty();

  const weights = p.holdings.map((h) => dec(h.weight));
  const holdingsSeries: DateClose[][] = [];
  for (const h of p.holdings) {
    holdingsSeries.push(await loadPrices(db, h.securityId));
  }

  const benchSeries = await loadBenchmarkSeriesDb(db, benchmarkCode);
  const { matrix } = intersectAlignedCloses([...holdingsSeries, benchSeries]);
  const k = holdingsSeries.length;
  if (matrix.length !== k + 1 || matrix[0]!.length < 3) return empty();

  const holdingMatrix = matrix.slice(0, k);
  const benchCloses = matrix[k]!;
  const holdingDaily = dailyReturnVectorsFromMatrix(holdingMatrix);
  const benchDaily = dailyReturnsFromAdjustedCloses(benchCloses);
  const n = Math.min(holdingDaily.length, benchDaily.length);
  const hd = holdingDaily.slice(-n);
  const bd = benchDaily.slice(-n);
  const portDaily = portfolioDailyReturnSeries(weights, hd);
  const benchSlice = bd.slice(-portDaily.length);
  const rf = riskFreeAnnual();

  return {
    daily: portDaily,
    annualizedReturn: annualizedReturnFromPortDaily(portDaily),
    annualizedVol: annualizedPortVol(portDaily),
    sharpe: portfolioSharpe(portDaily, rf),
    benchmarkDaily: benchSlice,
    benchmarkAnnReturn:
      benchSlice.length > 1
        ? annualizedReturnFromPortDaily(benchSlice)
        : null,
    benchmarkAnnVol: annualizedPortVol(benchSlice),
    benchmarkSharpe: portfolioSharpe(benchSlice, rf),
  };
}
