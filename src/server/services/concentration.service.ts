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
    where: { portfolioId },
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
  const marketValues = positions.map((p) => {
    if (p.isCash) {
      return p.cashAmount != null ? Number(p.cashAmount) : 0;
    }
    const price = lastPrices[equityIdx] ? Number(lastPrices[equityIdx]!.adjClose) : 0;
    equityIdx++;
    return Math.abs(Number(p.shares) * price);
  });
  const totalValue = marketValues.reduce((s, v) => s + v, 0);
  const weights = marketValues.map((v) => (totalValue > 0 ? v / totalValue : 0));
  const equityTickers = equityPositions.map((p) => p.security!.ticker);

  const sectorMap = new Map<string, number>();
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    const sector = p.isCash
      ? "Cash"
      : (p.sector ?? p.security!.sector ?? "Other");
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + marketValues[i]!);
  }
  const sectorAllocation = Array.from(sectorMap.entries())
    .map(([sector, value]) => ({ sector, value, pct: totalValue > 0 ? value / totalValue : 0 }))
    .sort((a, b) => b.value - a.value);

  const returnSeries = await Promise.all(
    equityPositions.map((p) =>
      db.priceHistory
        .findMany({
          where: { securityId: p.securityId! },
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

  const dendrogram =
    equityTickers.length > 1 && corrMat.length > 0
      ? clusterCorrelation(equityTickers, corrMat)
      : null;

  return {
    hhi: hhi(weights),
    effectiveN: effectiveN(weights),
    positionCount: positions.length,
    top5Pct: topKConcentration(weights, 5),
    top10Pct: topKConcentration(weights, 10),
    sectorAllocation,
    dendrogram,
    tickers: equityTickers,
    corrMatrix: corrMat,
    weights,
  };
}
