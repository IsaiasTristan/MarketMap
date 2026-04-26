/**
 * factor-drivers.service — per-position and grouped factor driver analysis.
 *
 * Computes per-security factor loadings from their price return series,
 * then aggregates by position / sector / sub-theme.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { computeHoldingsLoadings, type SecurityReturnSeries } from "@/lib/factors/drivers/holdings-loadings";
import { computeDrivers } from "@/lib/factors/drivers/aggregation";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import type { DriversResult, FactorCode, ModelPresetName } from "@/types/factors";

export async function getFactorDrivers(
  portfolioId: string,
  model: ModelPresetName,
  groupBy: "position" | "sector" | "subTheme",
  window: number,
  ewHalfLife?: number | null,
): Promise<DriversResult | null> {
  const preset = resolveModel(model);
  const factorCodes = preset.factors as FactorCode[];

  // Load positions + prices
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return null;

  const secIds = positions.map((p) => p.securityId);

  // Load universe sub-theme info for positions
  const universeRows = await db.universeConstituent.findMany({
    where: { securityId: { in: secIds } },
    select: { securityId: true, subTheme: true, sector: true },
  });
  const universeMap = new Map(universeRows.map((r) => [r.securityId, r]));

  // Load prices
  const priceData = await Promise.all(
    secIds.map((id) =>
      db.priceHistory.findMany({
        where: { securityId: id },
        orderBy: { tradeDate: "asc" },
        select: { adjClose: true, tradeDate: true },
      }),
    ),
  );

  // Load factor returns
  const allDates = [
    ...new Set(priceData.flatMap((rows) => rows.map((r) => r.tradeDate.toISOString().slice(0, 10)))),
  ].sort();

  const factorRows = await db.factorReturnDaily.findMany({
    where: {
      tradeDate: { gte: new Date(allDates[0]!), lte: new Date(allDates[allDates.length - 1]!) },
      factorCode: { in: factorCodes },
    },
    select: { tradeDate: true, factorCode: true, value: true },
  });

  const rfRows = await db.factorReturnDaily.findMany({
    where: {
      tradeDate: { gte: new Date(allDates[0]!), lte: new Date(allDates[allDates.length - 1]!) },
      factorCode: "RF",
    },
    select: { tradeDate: true, value: true },
  });

  // Build factor map
  const factorByDate = new Map<string, Record<string, number>>();
  const rfByDate = new Map<string, number>();
  for (const r of factorRows) {
    const d = r.tradeDate.toISOString().slice(0, 10);
    if (!factorByDate.has(d)) factorByDate.set(d, {});
    factorByDate.get(d)![r.factorCode] = Number(r.value);
  }
  for (const r of rfRows) {
    const d = r.tradeDate.toISOString().slice(0, 10);
    // Stored as daily simple decimal (KF native convention); no /252.
    rfByDate.set(d, Number(r.value));
  }

  // Common dates across all securities + factor data
  const priceMaps = priceData.map((rows) =>
    new Map(rows.map((r) => [r.tradeDate.toISOString().slice(0, 10), Number(r.adjClose)])),
  );
  const commonDates = allDates.filter(
    (d) => priceMaps.every((m) => m.has(d)) && factorByDate.has(d),
  );

  if (commonDates.length < 30) return null;

  // Build aligned factor matrix
  const alignedFactorMatrix: number[][] = commonDates.map((d) => {
    const day = factorByDate.get(d)!;
    return factorCodes.map((c) => day[c] ?? 0);
  });
  const alignedRf: number[] = commonDates.map((d) => rfByDate.get(d) ?? 0);

  // Build per-security return series
  const costs = positions.map((p) => Number(p.shares) * Number(p.entryPrice));
  const totalCost = costs.reduce((s, c) => s + c, 0);
  const weights = costs.map((c) => (totalCost > 0 ? c / totalCost : 0));

  const securities: SecurityReturnSeries[] = positions.map((pos, i) => {
    const pm = priceMaps[i]!;
    const prices = commonDates.map((d) => pm.get(d)!);
    const returns = dailyReturnsFromAdjustedCloses(prices);
    const uRow = universeMap.get(pos.securityId);
    return {
      ticker: pos.security.ticker,
      sector: pos.sector ?? uRow?.sector ?? pos.security.sector ?? "Other",
      subTheme: uRow?.subTheme ?? "Other",
      weight: weights[i]!,
      dates: commonDates.slice(1),
      returns,
    };
  });

  // Only use the return rows (length = commonDates.length - 1)
  const factorMatrixForReturns = alignedFactorMatrix.slice(1);
  const rfForReturns = alignedRf.slice(1);

  const loadings = computeHoldingsLoadings(
    securities,
    factorCodes,
    factorMatrixForReturns,
    rfForReturns,
    window,
    ewHalfLife,
  );

  return computeDrivers(loadings, factorCodes, groupBy);
}
