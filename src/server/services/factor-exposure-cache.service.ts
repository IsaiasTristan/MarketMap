/**
 * factor-exposure-cache.service — build/read/write/precompute the Factors-tab
 * exposure response (FactorExposureGridSnapshot).
 *
 * The exposure GET route runs the full factor engine (+ holdings + residual
 * stats) on every request. The daily job + market-hours runner precompute the
 * response per (portfolioId, model, window) and store the JSON blob here; the
 * route reads the cached row and only falls back to live compute on a miss
 * (then writes through).
 *
 * The snapshot-building logic lives here (not inline in the route) so the route
 * cold-miss path and the precompute produce a byte-identical payload.
 *
 * Cache key: (portfolioId, model, regressionWindow).
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import { runFactorEngine } from "./factor-engine.service";
import { computeFactorExposures } from "./factor.service";
import { computePortfolioResidualStats } from "./factor-portfolio-residual.service";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type {
  FactorExposureSnapshot,
  FactorCode,
  FactorEngineResult,
  ModelPresetName,
} from "@/types/factors";

/**
 * Build the full exposure response for a (portfolio, model, window). Returns
 * null when the engine has insufficient aligned data (the route maps that to a
 * 422). Optionally accepts a pre-computed engine result so a caller that
 * already ran the engine (e.g. the daily rolling-beta loop) can avoid a second
 * pass.
 */
export async function buildFactorExposureSnapshot(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
  precomputedEngine?: FactorEngineResult | null,
): Promise<FactorExposureSnapshot | null> {
  const [engineResult, holdingsResult, residualStats] = await Promise.all([
    precomputedEngine !== undefined
      ? Promise.resolve(precomputedEngine)
      : runFactorEngine({ portfolioId, model, window: win }),
    computeFactorExposures(portfolioId).catch(() => null),
    computePortfolioResidualStats({ portfolioId, model, window: win }).catch(
      () => null,
    ),
  ]);

  if (!engineResult) return null;

  const { endFit, risk, factors: factorCodes } = engineResult;
  const asOfDate =
    engineResult.dates[engineResult.dates.length - 1] ??
    new Date().toISOString().slice(0, 10);

  const holdingsMap: Partial<Record<FactorCode, number>> = {};
  if (holdingsResult) {
    holdingsMap["MKT_RF"] = holdingsResult.marketBeta;
    holdingsMap["SMB"] = holdingsResult.sizeFactor;
    holdingsMap["HML"] = holdingsResult.valueFactor;
    holdingsMap["MOM"] = holdingsResult.momentumFactor;
    holdingsMap["RMW"] = holdingsResult.qualityFactor;
  }

  const windowReturns = engineResult.portTotalReturns.slice(-win);
  const totalReturn = windowReturns.reduce((s, r) => s + r, 0);
  const pctReturnContribs: Record<string, number> = {};
  for (let i = 0; i < factorCodes.length; i++) {
    const code = factorCodes[i]!;
    const beta = endFit.betas[i] ?? 0;
    const factorWindowReturns = engineResult.factorReturns[code]?.slice(-win) ?? [];
    const factorTotal = factorWindowReturns.reduce((s, r) => s + beta * r, 0);
    pctReturnContribs[code] =
      Math.abs(totalReturn) > 1e-10 ? factorTotal / Math.abs(totalReturn) : 0;
  }

  const totalAbsPCR = risk.factors.reduce(
    (s, f) => s + Math.abs(f.pctVarianceContrib),
    0,
  );
  const concentrationHHI =
    totalAbsPCR > 0
      ? risk.factors.reduce(
          (s, f) => s + (Math.abs(f.pctVarianceContrib) / totalAbsPCR) ** 2,
          0,
        )
      : 0;

  const yEnd = engineResult.portExcessReturns.slice(-win);
  let realizedAnnualizedVol = 0;
  let varGapPct = 0;
  if (yEnd.length >= 2) {
    const mean = yEnd.reduce((s, v) => s + v, 0) / yEnd.length;
    const sampleVar =
      yEnd.reduce((s, v) => s + (v - mean) ** 2, 0) / (yEnd.length - 1);
    realizedAnnualizedVol = Math.sqrt(sampleVar * 252);
    const realizedVar = realizedAnnualizedVol ** 2;
    const modelVar = (risk.totalVolatility ?? 0) ** 2;
    varGapPct = realizedVar > 0 ? (modelVar - realizedVar) / realizedVar : 0;
  }

  const snapshot: FactorExposureSnapshot = {
    factors: factorCodes.map((code, i) => {
      const riskEntry = risk.factors[i];
      return {
        code,
        label: getFactorDef(code).label,
        beta: endFit.betas[i] ?? 0,
        tStat: endFit.tStats[i] ?? 0,
        stdError: endFit.stdErrors[i] ?? 0,
        holdingsImplied: holdingsMap[code] ?? null,
        pctRiskContrib: riskEntry?.pctVarianceContrib ?? 0,
        pctReturnContrib: pctReturnContribs[code] ?? 0,
      };
    }),
    alphaAnnualized: endFit.alpha * 252,
    alphaTStat: endFit.alphaTStat,
    alphaAnnualizedLog: engineResult.endFitLog
      ? engineResult.endFitLog.alpha * 252
      : null,
    alphaTStatLog: engineResult.endFitLog ? engineResult.endFitLog.alphaTStat : null,
    alphaCi95HalfLog: engineResult.endFitLog
      ? 1.96 * engineResult.endFitLog.alphaStdError * 252
      : null,
    rSquared: endFit.rSquared,
    adjRSquared: endFit.adjRSquared,
    concentrationHHI,
    systematicShare: risk.systematicShare,
    idiosyncraticShare: risk.idiosyncraticShare,
    realizedAnnualizedVol,
    varGapPct,
    residual: residualStats
      ? {
          sum: residualStats.residualSum,
          mean: residualStats.residualMean,
          tStat: residualStats.residualTStat,
          ci95Half: residualStats.residualCi95Half,
          annualizedVol: residualStats.residualAnnualizedVol,
          bandwidth: residualStats.diagnostics.bandwidth,
          n: residualStats.diagnostics.n,
          startDate: residualStats.diagnostics.startDate,
          endDate: residualStats.diagnostics.endDate,
          droppedHoldings: residualStats.diagnostics.droppedHoldings,
          coverageWeight: residualStats.diagnostics.coverageWeight,
          sumLog: residualStats.residualSumLog,
          meanLog: residualStats.residualMeanLog,
          tStatLog: residualStats.residualTStatLog,
          ci95HalfLog: residualStats.residualCi95HalfLog,
          annualizedVolLog: residualStats.residualAnnualizedVolLog,
          bandwidthLog: residualStats.diagnostics.bandwidthLog,
          nLog: residualStats.diagnostics.nLog,
        }
      : undefined,
    model,
    window: win,
    n: endFit.n,
    asOfDate,
    hasFundamentals: holdingsResult?.hasFundamentals ?? false,
    regularized: endFit.regularized,
    normalizationApplied: true,
    normalization: engineResult.normalization,
    coverage: engineResult.coverage,
  };

  return snapshot;
}

/** Read a cached exposure response, or null on miss. */
export async function readFactorExposureCache(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
): Promise<FactorExposureSnapshot | null> {
  const row = await db.factorExposureGridSnapshot.findUnique({
    where: {
      portfolioId_model_regressionWindow: {
        portfolioId,
        model,
        regressionWindow: win,
      },
    },
    select: { payloadJson: true },
  });
  if (!row) return null;
  return row.payloadJson as unknown as FactorExposureSnapshot;
}

/** Upsert a cached exposure response. */
export async function writeFactorExposureCache(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
  snapshot: FactorExposureSnapshot,
): Promise<void> {
  const json = snapshot as unknown as Prisma.InputJsonValue;
  const asOfDate = snapshot.asOfDate
    ? new Date(`${snapshot.asOfDate}T00:00:00.000Z`)
    : new Date();
  await db.factorExposureGridSnapshot.upsert({
    where: {
      portfolioId_model_regressionWindow: {
        portfolioId,
        model,
        regressionWindow: win,
      },
    },
    update: { payloadJson: json, asOfDate, computedAt: new Date() },
    create: {
      portfolioId,
      model,
      regressionWindow: win,
      asOfDate,
      payloadJson: json,
    },
  });
}

/**
 * Build + persist the exposure snapshot. Returns the snapshot (or null on
 * insufficient data). Optionally reuses a precomputed engine result.
 */
export async function computeAndCacheFactorExposure(
  portfolioId: string,
  model: ModelPresetName,
  win: number,
  precomputedEngine?: FactorEngineResult | null,
): Promise<FactorExposureSnapshot | null> {
  const snapshot = await buildFactorExposureSnapshot(
    portfolioId,
    model,
    win,
    precomputedEngine,
  );
  if (snapshot) await writeFactorExposureCache(portfolioId, model, win, snapshot);
  return snapshot;
}
