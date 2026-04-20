import { prisma as db } from "@/infrastructure/db/client";
import {
  hhi,
  effectiveN,
  topKConcentration,
  clusterCorrelation,
  type ClusterNode,
} from "@/domain/calculations/concentration";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { correlationMatrix } from "@/domain/calculations/correlation";

export interface ConcentrationMetrics {
  hhi: number;
  effectiveN: number;
  positionCount: number;
  top5Pct: number;
  top10Pct: number;
  sectorAllocation: { sector: string; pct: number; value: number }[];
  dendrogram: ClusterNode | null;
  tickers: string[];
  corrMatrix: number[][];
  weights: number[];
}

export async function computeConcentration(
  portfolioId: string,
): Promise<ConcentrationMetrics> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });

  if (!positions.length) {
    return {
      hhi: 0,
      effectiveN: 0,
      positionCount: 0,
      top5Pct: 0,
      top10Pct: 0,
      sectorAllocation: [],
      dendrogram: null,
      tickers: [],
      corrMatrix: [],
      weights: [],
    };
  }

  // Get last prices
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
  const tickers = positions.map((p) => p.security.ticker);

  // Sector allocation
  const sectorMap = new Map<string, number>();
  for (let i = 0; i < positions.length; i++) {
    const sector = positions[i].sector ?? positions[i].security.sector ?? "Other";
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + marketValues[i]);
  }
  const sectorAllocation = Array.from(sectorMap.entries())
    .map(([sector, value]) => ({ sector, value, pct: totalValue > 0 ? value / totalValue : 0 }))
    .sort((a, b) => b.value - a.value);

  // Correlation matrix
  const returnSeries = await Promise.all(
    positions.map((p) =>
      db.priceHistory
        .findMany({
          where: { securityId: p.securityId },
          orderBy: { tradeDate: "desc" },
          take: 253,
          select: { adjClose: true },
        })
        .then((rows) => dailyReturnsFromAdjustedCloses(rows.reverse().map((r) => Number(r.adjClose)))),
    ),
  );

  const minLen = Math.min(...returnSeries.map((r) => r.length));
  const aligned = returnSeries.map((r) => r.slice(-minLen));
  const corrMat = aligned.length > 0 ? correlationMatrix(aligned) : [];

  // Dendrogram
  const dendrogram =
    tickers.length > 1 && corrMat.length > 0
      ? clusterCorrelation(tickers, corrMat)
      : null;

  return {
    hhi: hhi(weights),
    effectiveN: effectiveN(weights),
    positionCount: positions.length,
    top5Pct: topKConcentration(weights, 5),
    top10Pct: topKConcentration(weights, 10),
    sectorAllocation,
    dendrogram,
    tickers,
    corrMatrix: corrMat,
    weights,
  };
}
