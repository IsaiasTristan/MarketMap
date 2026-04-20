/**
 * factor-engine.service — single orchestrator for institutional factor analysis.
 *
 * Loads aligned portfolio return and factor return series, fits the chosen
 * multi-factor model, and returns exposure, attribution, and risk data.
 *
 * All callers (API routes) use this service; they do NOT access domain
 * calculation functions directly.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { multivariateOls } from "@/lib/factors/regression/ols";
import { rollingMultivariateOls } from "@/lib/factors/regression/rolling";
import { exponentialWeights } from "@/lib/factors/regression/weights";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { computeRiskDecomposition } from "@/lib/factors/risk/decomposition";
import { resolveModel, minObservations } from "@/lib/factors/definitions/model-presets";
import type { FactorCode, FactorEngineParams, FactorEngineResult, ModelPresetName } from "@/types/factors";

// Minimum common prices required across all portfolio positions
const MIN_PRICE_HISTORY = 30;

/** Load the aligned portfolio return series from open positions. */
async function loadPortfolioReturns(portfolioId: string, from?: string, to?: string) {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId, closedAt: null },
    include: { security: true },
  });
  if (!positions.length) return null;

  const secIds = positions.map((p) => p.securityId);
  const priceData = await Promise.all(
    secIds.map((id) =>
      db.priceHistory.findMany({
        where: {
          securityId: id,
          ...(from ? { tradeDate: { gte: new Date(from) } } : {}),
          ...(to ? { tradeDate: { lte: new Date(to) } } : {}),
        },
        orderBy: { tradeDate: "asc" },
        select: { adjClose: true, tradeDate: true },
      }),
    ),
  );

  // Build date→price maps per security
  const priceMaps = priceData.map((rows) =>
    new Map(rows.map((r) => [r.tradeDate.toISOString().slice(0, 10), Number(r.adjClose)])),
  );

  // Common dates (inner join)
  const allDates = [
    ...new Set(
      priceData.flatMap((rows) => rows.map((r) => r.tradeDate.toISOString().slice(0, 10))),
    ),
  ].sort();
  const commonDates = allDates.filter((d) => priceMaps.every((m) => m.has(d)));

  if (commonDates.length < MIN_PRICE_HISTORY) return null;

  // Cost-based weights (stable, avoids look-ahead from market values)
  const costs = positions.map((p) => Number(p.shares) * Number(p.entryPrice));
  const totalCost = costs.reduce((s, c) => s + c, 0);
  const weights = costs.map((c) => (totalCost > 0 ? c / totalCost : 0));

  // Compute daily portfolio returns
  const portReturns: number[] = [];
  for (let i = 1; i < commonDates.length; i++) {
    let r = 0;
    for (let j = 0; j < secIds.length; j++) {
      const prev = priceMaps[j]!.get(commonDates[i - 1]!);
      const cur = priceMaps[j]!.get(commonDates[i]!);
      if (prev && cur && prev > 0) r += weights[j]! * ((cur - prev) / prev);
    }
    portReturns.push(r);
  }

  return {
    dates: commonDates.slice(1),
    returns: portReturns,
    positions: positions.map((p, i) => ({
      ticker: p.security.ticker,
      securityId: p.securityId,
      weight: weights[i]!,
      sector: p.sector ?? p.security.sector ?? "Other",
      subTheme: "Other", // will be enriched from universe if needed
    })),
  };
}

/** Load factor return series from FactorReturnDaily, aligned to the given dates. */
async function loadFactorReturns(
  dates: string[],
  factorCodes: FactorCode[],
): Promise<{ factorMap: Map<string, Record<string, number>>; rfMap: Map<string, number> }> {
  if (!dates.length) return { factorMap: new Map(), rfMap: new Map() };

  const rows = await db.factorReturnDaily.findMany({
    where: {
      tradeDate: { gte: new Date(dates[0]!), lte: new Date(dates[dates.length - 1]!) },
    },
    select: { tradeDate: true, factorCode: true, value: true },
    orderBy: { tradeDate: "asc" },
  });

  const factorMap = new Map<string, Record<string, number>>();
  const rfMap = new Map<string, number>();

  for (const row of rows) {
    const d = row.tradeDate.toISOString().slice(0, 10);
    if (row.factorCode === "RF") {
      // RF from FactorReturnDaily is the annual rate — convert to daily
      rfMap.set(d, Number(row.value) / 252);
    } else {
      if (!factorMap.has(d)) factorMap.set(d, {});
      factorMap.get(d)![row.factorCode] = Number(row.value);
    }
  }

  return { factorMap, rfMap };
}

/**
 * Run the full factor engine for a portfolio.
 *
 * Returns null when there is insufficient data (< minObservations).
 */
export async function runFactorEngine(
  params: FactorEngineParams,
): Promise<FactorEngineResult | null> {
  const model = resolveModel(params.model);
  const factorCodes = model.factors as FactorCode[];
  const regressionWindow = params.window;
  const ewHalfLife = params.ewHalfLife ?? null;

  // Load portfolio returns
  const portfolio = await loadPortfolioReturns(params.portfolioId, params.from, params.to);
  if (!portfolio) return null;

  const { dates: portDates, returns: portTotals } = portfolio;

  // Load factor returns aligned to portfolio dates
  const { factorMap, rfMap } = await loadFactorReturns(portDates, factorCodes);

  // Inner join on dates that have BOTH portfolio returns AND all factor returns
  const alignedDates: string[] = [];
  const portTotalReturns: number[] = [];
  const rfReturns: number[] = [];
  const factorRows: number[][] = []; // n × k

  for (let i = 0; i < portDates.length; i++) {
    const d = portDates[i]!;
    const fDay = factorMap.get(d);
    if (!fDay) continue;

    const allFactorsPresent = factorCodes.every((c) => fDay[c] !== undefined);
    if (!allFactorsPresent) continue;

    alignedDates.push(d);
    portTotalReturns.push(portTotals[i]!);
    rfReturns.push(rfMap.get(d) ?? 0);
    factorRows.push(factorCodes.map((c) => fDay[c]!));
  }

  const n = alignedDates.length;
  const k = factorCodes.length;
  const minObs = minObservations(k);

  if (n < minObs) return null;

  // Portfolio excess returns (subtract daily RF for regression LHS)
  const portExcessReturns = portTotalReturns.map((r, i) => r - rfReturns[i]!);

  // End-of-period fit over full available history (capped at regressionWindow)
  const windowN = Math.min(regressionWindow, n);
  const startIdx = n - windowN;
  const yEnd = portExcessReturns.slice(startIdx);
  const xEnd = factorRows.slice(startIdx);
  const endWeights = exponentialWeights(windowN, ewHalfLife);
  const endFit = multivariateOls(yEnd, xEnd, endWeights);

  // Rolling fits
  const rollingFits = rollingMultivariateOls(
    alignedDates,
    portExcessReturns,
    factorRows,
    regressionWindow,
    ewHalfLife,
  );

  // Risk decomposition
  // Factor covariance matrix from the window used in end-of-period fit
  const covWindow = Math.min(regressionWindow, n);
  const factorSeriesWindow = factorCodes.map((_, fi) =>
    factorRows.slice(-covWindow).map((row) => row[fi]!),
  );
  const covMatrix = factorCovarianceMatrix(factorSeriesWindow, null, true);

  // Idiosyncratic variance from end-fit residuals (daily, unannualized for decomp)
  const residualDailyVar = endFit.residuals.length > 1
    ? endFit.residuals.reduce((s, e) => s + e ** 2, 0) / Math.max(1, endFit.residuals.length - k - 1)
    : 0;

  const risk = computeRiskDecomposition(endFit.betas, covMatrix, residualDailyVar, factorCodes, covWindow);

  // Per-factor return series (for market context, attribution)
  const factorReturns: Record<string, number[]> = {};
  for (const code of factorCodes) {
    factorReturns[code] = alignedDates.map((d) => factorMap.get(d)?.[code] ?? 0);
  }

  return {
    dates: alignedDates,
    portExcessReturns,
    portTotalReturns,
    factorReturns,
    rfReturns,
    endFit,
    rollingFits,
    risk,
    holdingsImplied: null, // populated by factor.service separately
    model: params.model,
    factors: factorCodes,
  };
}

/**
 * Get all factor return series from DB, ordered by date.
 * Used for market-context and correlation calculations.
 */
export async function getAllFactorReturnSeries(
  window?: number,
): Promise<{ dates: string[]; byFactor: Map<string, number[]>; rfSeries: number[] }> {
  const rows = await db.factorReturnDaily.findMany({
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, factorCode: true, value: true },
  });

  const dateSet = new Set<string>();
  const raw = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const d = row.tradeDate.toISOString().slice(0, 10);
    dateSet.add(d);
    if (!raw.has(d)) raw.set(d, new Map());
    raw.get(d)!.set(row.factorCode, Number(row.value));
  }

  const allDates = [...dateSet].sort();
  const dates = window ? allDates.slice(-window) : allDates;

  const byFactor = new Map<string, number[]>();
  const rfSeries: number[] = [];

  for (const d of dates) {
    const day = raw.get(d) ?? new Map<string, number>();
    rfSeries.push((day.get("RF") ?? 0) / 252);
    for (const [code, val] of day.entries()) {
      if (code === "RF") continue;
      if (!byFactor.has(code)) byFactor.set(code, []);
      byFactor.get(code)!.push(val);
    }
  }

  return { dates, byFactor, rfSeries };
}
