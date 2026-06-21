import type { PrismaClient } from "@prisma/client";
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

export async function listPortfolios(db: PrismaClient, userId: string) {
  return db.portfolio.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { positions: true } } },
  });
}

export async function getPortfolio(db: PrismaClient, id: string) {
  return db.portfolio.findUnique({
    where: { id },
    include: { positions: { include: { security: true } } },
  });
}

export async function createPortfolio(
  db: PrismaClient,
  name: string,
  userId: string,
) {
  return db.portfolio.create({ data: { name, userId } });
}

export async function renamePortfolio(db: PrismaClient, id: string, name: string) {
  return db.portfolio.update({ where: { id }, data: { name } });
}

export async function deletePortfolio(db: PrismaClient, id: string) {
  await db.portfolio.delete({ where: { id } });
}

// ─── Weight derivation ──────────────────────────────────────────────────
//
// Single source of truth for portfolio weights. Reads PortfolioPosition rows
// (the canonical user input: ticker + shares + isShort), pulls the latest
// available price for each security, and derives:
//   • grossWeight  = |shares × price| / Σ |shares × price|
//   • signedWeight = (isShort ? -1 : +1) × grossWeight
//
// gross weights always sum to 1 (used for HHI / sector concentration);
// signed weights net to (longs − shorts) ∈ [-1, +1] and feed every
// portfolio-level analytic (returns, factor regression, P&L) so a short
// position correctly subtracts exposure / inverts daily P&L.

export interface PortfolioWeight {
  positionId: string;
  securityId: string;
  ticker: string;
  name: string;
  shares: number;
  isShort: boolean;
  lastPrice: number;
  marketValue: number;
  grossWeight: number;
  signedWeight: number;
  sector: string | null;
}

export async function loadPortfolioWeights(
  db: PrismaClient,
  portfolioId: string
): Promise<PortfolioWeight[]> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });
  if (!positions.length) return [];

  const lastPrices = await Promise.all(
    positions.map((p) =>
      db.priceHistory.findFirst({
        where: { securityId: p.securityId },
        orderBy: { tradeDate: "desc" },
        select: { adjClose: true },
      })
    )
  );

  const rows = positions.map((p, i) => {
    const lastPrice = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : 0;
    const shares = Number(p.shares);
    return {
      positionId: p.id,
      securityId: p.securityId,
      ticker: p.security.ticker,
      name: p.security.name,
      shares,
      isShort: p.isShort,
      lastPrice,
      // Always positive — gross capital allocated to this name.
      marketValue: Math.abs(shares * lastPrice),
      sector: p.sector ?? p.security.sector ?? null,
    };
  });

  const totalGross = rows.reduce((s, r) => s + r.marketValue, 0);
  return rows.map((r) => {
    const gross = totalGross > 0 ? r.marketValue / totalGross : 0;
    return {
      ...r,
      grossWeight: gross,
      signedWeight: (r.isShort ? -1 : 1) * gross,
    };
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

  const weighted = await loadPortfolioWeights(db, portfolioId);
  if (weighted.length === 0) return empty();

  // Use signed weights so a short position contributes -return to the
  // portfolio's daily series.
  const signedWeights = weighted.map((w) => w.signedWeight);
  const holdingsSeries: DateClose[][] = [];
  for (const w of weighted) {
    holdingsSeries.push(await loadPrices(db, w.securityId));
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
  const portDaily = portfolioDailyReturnSeries(signedWeights, hd);
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
