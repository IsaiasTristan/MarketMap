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
import { normalizeFactorRows } from "@/lib/factors/regression/normalization";
import { getFactorInputType } from "@/lib/factors/definitions/factor-codes";
import {
  factorRowLog,
  logOnePlus,
  stockExcessLog,
} from "@/lib/factors/attribution/log-returns";
import type {
  FactorCode,
  FactorEngineParams,
  FactorEngineResult,
  ModelPresetName,
  RegressionFit,
  RollingFitPoint,
} from "@/types/factors";

// Minimum common prices required across all portfolio positions
const MIN_PRICE_HISTORY = 30;

/** Load the aligned portfolio return series. Weights derive from
 *  shares × latest price; long/short sign is applied so a short position
 *  contributes -return to the portfolio's daily series. */
async function loadPortfolioReturns(portfolioId: string, from?: string, to?: string) {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });
  if (!positions.length) return null;

  const secIds = positions.map((p) => p.securityId);
  const [priceData, lastPrices] = await Promise.all([
    Promise.all(
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
    ),
    Promise.all(
      secIds.map((id) =>
        db.priceHistory.findFirst({
          where: { securityId: id },
          orderBy: { tradeDate: "desc" },
          select: { adjClose: true },
        }),
      ),
    ),
  ]);

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

  // Market-value weights at the latest available price, with long/short
  // sign applied. This represents "given my portfolio as it stands today,
  // what is its factor exposure?" — the natural anchor when there is no
  // entry-price model.
  const grossValues = positions.map((p, i) => {
    const price = lastPrices[i] ? Number(lastPrices[i]!.adjClose) : 0;
    return Math.abs(Number(p.shares) * price);
  });
  const totalGross = grossValues.reduce((s, c) => s + c, 0);
  const weights = positions.map((p, i) => {
    const gross = totalGross > 0 ? grossValues[i]! / totalGross : 0;
    return (p.isShort ? -1 : 1) * gross;
  });

  // Compute daily portfolio returns using signed weights — shorts subtract
  // from the daily P&L when the underlying rises.
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
      isShort: p.isShort,
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
      // RF in FactorReturnDaily is stored as a daily simple decimal — same
      // convention as every other code in this table (KF's native CSV is
      // percent-per-day; the FRED DGS1MO back-fill is calibrated to that
      // daily level). Use directly without per-read division.
      rfMap.set(d, Number(row.value));
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

  const normResult = normalizeFactorRows(
    factorRows,
    factorCodes.map((code) => ({ code, inputType: getFactorInputType(code) })),
    {
      rollingWindow: 252,
      minObservations: 60,
      winsorSigma: 5,
      targetAnnualVol: 0.1,
    },
  );

  const finalDates: string[] = [];
  const finalPortTotalReturns: number[] = [];
  const finalRfReturns: number[] = [];
  const finalFactorRowsRaw: number[][] = [];
  const finalFactorRowsNorm: number[][] = [];

  for (let i = 0; i < alignedDates.length; i++) {
    const normRow = normResult.normalizedRows[i];
    if (!normRow || normRow.some((v) => v == null || !Number.isFinite(v))) continue;
    finalDates.push(alignedDates[i]!);
    finalPortTotalReturns.push(portTotalReturns[i]!);
    finalRfReturns.push(rfReturns[i]!);
    finalFactorRowsRaw.push(factorRows[i]!);
    finalFactorRowsNorm.push(normRow as number[]);
  }

  const n = finalDates.length;
  const k = factorCodes.length;
  const minObs = minObservations(k);

  if (n < minObs) return null;

  // Portfolio excess returns (subtract daily RF for regression LHS)
  const portExcessReturns = finalPortTotalReturns.map((r, i) => r - finalRfReturns[i]!);

  // End-of-period fit over full available history (capped at regressionWindow)
  const windowN = Math.min(regressionWindow, n);
  const startIdx = n - windowN;
  const yEnd = portExcessReturns.slice(startIdx);
  const xEnd = finalFactorRowsNorm.slice(startIdx);
  const endWeights = exponentialWeights(windowN, ewHalfLife);
  const endFit = multivariateOls(yEnd, xEnd, endWeights);

  // Rolling fits.
  //
  // Cap the rolling window to the actually-available aligned history so that
  // a requested HORIZON preset (e.g. 504d) doesn't produce an empty
  // `rollingFits` array when the factor matrix is short by a handful of days
  // (typical: AQR/KF publish lag, holidays). The end-fit + risk Σ already
  // use `Math.min(regressionWindow, n)`, so this mirrors that behaviour and
  // unblocks `computeFactorAttribution` for the common ~10–25 day shortfall.
  // Mirrors the per-stock timeseries `windowFallback` contract.
  const effectiveRollingWindow = Math.min(regressionWindow, n);
  const windowFallback =
    n < regressionWindow
      ? {
          requestedWindow: regressionWindow,
          effectiveWindow: effectiveRollingWindow,
          availableObservations: n,
        }
      : null;
  const rollingFits = rollingMultivariateOls(
    finalDates,
    portExcessReturns,
    finalFactorRowsNorm,
    effectiveRollingWindow,
    ewHalfLife,
  );

  // Risk decomposition
  // Factor covariance matrix from the window used in end-of-period fit
  const covWindow = Math.min(regressionWindow, n);
  const factorSeriesWindow = factorCodes.map((_, fi) =>
    finalFactorRowsNorm.slice(-covWindow).map((row) => row[fi]!),
  );
  const covMatrix = factorCovarianceMatrix(factorSeriesWindow, null, true);

  // Idiosyncratic variance from end-fit residuals (daily, unannualized for decomp)
  const residualDailyVar = endFit.residuals.length > 1
    ? endFit.residuals.reduce((s, e) => s + e ** 2, 0) / Math.max(1, endFit.residuals.length - k - 1)
    : 0;

  const risk = computeRiskDecomposition(endFit.betas, covMatrix, residualDailyVar, factorCodes, covWindow);

  // Per-factor return series (for market context, attribution)
  const factorReturns: Record<string, number[]> = {};
  for (let fi = 0; fi < factorCodes.length; fi++) {
    const code = factorCodes[fi]!;
    factorReturns[code] = finalFactorRowsRaw.map((row) => row[fi] ?? 0);
  }

  // ---------------------------------------------------------------------
  // Path B — log-return rolling OLS over RAW (non-vol-scaled) factors.
  // ---------------------------------------------------------------------
  // Strict drop policy at portfolio level: if any date produces a log-domain
  // failure (1 + r ≤ 0) we leave Path B null so Path A is unaffected.
  let portExcessLogReturns: number[] | null = new Array(n);
  let rfLogReturns: number[] | null = new Array(n);
  const factorLogRows: number[][] = new Array(n);
  let logPathOk = true;
  for (let i = 0; i < n; i++) {
    const rfDaily = finalRfReturns[i] ?? 0;
    const portTotal = finalPortTotalReturns[i] ?? 0;
    const yLog = stockExcessLog(portTotal, rfDaily);
    const rfLog = logOnePlus(rfDaily);
    const xLog = factorRowLog(finalFactorRowsRaw[i]!);
    if (yLog == null || rfLog == null || xLog == null) {
      logPathOk = false;
      break;
    }
    portExcessLogReturns[i] = yLog;
    rfLogReturns[i] = rfLog;
    factorLogRows[i] = xLog;
  }

  let factorLogReturns: Record<string, number[]> | null = null;
  let endFitLog: RegressionFit | null = null;
  let rollingFitsLog: RollingFitPoint[] | null = null;

  if (logPathOk && portExcessLogReturns && rfLogReturns) {
    factorLogReturns = {};
    for (let fi = 0; fi < factorCodes.length; fi++) {
      const code = factorCodes[fi]!;
      factorLogReturns[code] = factorLogRows.map((row) => row[fi] ?? 0);
    }

    const yLogEnd = portExcessLogReturns.slice(startIdx);
    const xLogEnd = factorLogRows.slice(startIdx);
    endFitLog = multivariateOls(yLogEnd, xLogEnd, endWeights);
    rollingFitsLog = rollingMultivariateOls(
      finalDates,
      portExcessLogReturns,
      factorLogRows,
      effectiveRollingWindow,
      ewHalfLife,
    );
  } else {
    portExcessLogReturns = null;
    rfLogReturns = null;
  }

  return {
    dates: finalDates,
    portExcessReturns,
    portTotalReturns: finalPortTotalReturns,
    factorReturns,
    rfReturns: finalRfReturns,
    endFit,
    rollingFits,
    risk,
    holdingsImplied: null, // populated by factor.service separately
    model: params.model,
    factors: factorCodes,
    normalization: normResult.diagnostics,
    portExcessLogReturns,
    factorLogReturns,
    rfLogReturns,
    endFitLog,
    rollingFitsLog,
    windowFallback,
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
    rfSeries.push(day.get("RF") ?? 0);
    for (const [code, val] of day.entries()) {
      if (code === "RF") continue;
      if (!byFactor.has(code)) byFactor.set(code, []);
      byFactor.get(code)!.push(val);
    }
  }

  return { dates, byFactor, rfSeries };
}
