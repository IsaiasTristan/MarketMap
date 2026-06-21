/**
 * GET /api/analysis/factors/exposure
 * Returns current factor exposure snapshot (end-of-period betas, diagnostics, risk decomp).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { factorQueryParams } from "@/lib/api/schemas";
import { runFactorEngine } from "@/server/services/factor-engine.service";
import { persistFactorSnapshot } from "@/server/services/factor-snapshot.service";
import { evaluateFactorAlerts } from "@/server/services/factor-alerts.service";
import { computeFactorExposures } from "@/server/services/factor.service";
import { computePortfolioResidualStats } from "@/server/services/factor-portfolio-residual.service";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { requirePortfolioAccess } from "@/lib/api/guards";
import type { FactorExposureSnapshot, FactorCode, ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorQueryParams.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, ew } = parsed.data;

  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  const [engineResult, holdingsResult, residualStats] = await Promise.all([
    runFactorEngine({ portfolioId, model: model as ModelPresetName, window: win, ewHalfLife: ew }),
    computeFactorExposures(portfolioId).catch(() => null),
    // Constructed-from-per-stock residual series for the Total row's
    // Unexplained cell. Independent of the portfolio-level OLS — it's
    // built directly from per-stock rolling residuals so the number is
    // genuinely a roll-up of the grid. Failure here is non-fatal; the
    // Unexplained cell will fall back to "—".
    computePortfolioResidualStats({
      portfolioId,
      model: model as ModelPresetName,
      window: win,
    }).catch(() => null),
  ]);

  if (!engineResult) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Not enough aligned portfolio + factor return data." },
      { status: 422 },
    );
  }

  const { endFit, risk, factors: factorCodes } = engineResult;
  const asOfDate = engineResult.dates[engineResult.dates.length - 1] ?? new Date().toISOString().slice(0, 10);

  // Map holdings-implied scores
  const holdingsMap: Partial<Record<FactorCode, number>> = {};
  if (holdingsResult) {
    holdingsMap["MKT_RF"] = holdingsResult.marketBeta;
    holdingsMap["SMB"] = holdingsResult.sizeFactor;
    holdingsMap["HML"] = holdingsResult.valueFactor;
    holdingsMap["MOM"] = holdingsResult.momentumFactor;
    holdingsMap["RMW"] = holdingsResult.qualityFactor;
  }

  // Build pct return contributions (using last period of rolling fits)
  // Simple: factor return over full window / total portfolio return
  const windowReturns = engineResult.portTotalReturns.slice(-win);
  const totalReturn = windowReturns.reduce((s, r) => s + r, 0);
  const pctReturnContribs: Record<string, number> = {};
  for (let i = 0; i < factorCodes.length; i++) {
    const code = factorCodes[i]!;
    const beta = endFit.betas[i] ?? 0;
    const factorWindowReturns = engineResult.factorReturns[code]?.slice(-win) ?? [];
    const factorTotal = factorWindowReturns.reduce((s, r) => s + beta * r, 0);
    pctReturnContribs[code] = Math.abs(totalReturn) > 1e-10 ? factorTotal / Math.abs(totalReturn) : 0;
  }

  const totalAbsPCR = risk.factors.reduce((s, f) => s + Math.abs(f.pctVarianceContrib), 0);
  const concentrationHHI = totalAbsPCR > 0
    ? risk.factors.reduce((s, f) => s + (Math.abs(f.pctVarianceContrib) / totalAbsPCR) ** 2, 0)
    : 0;

  // Phase 3 §2.8 (Q4 lock): realised σ + varGapPct at portfolio level so the
  // PortfolioTotalsPanel mirrors the per-stock primary-headline hierarchy
  // (anchor to realised; model-implied is reconciliation).
  // Computed on the same regression window slice as `endFit` to keep the
  // identity (β'Σβ + σ²_idio) ↔ realised variance directly comparable.
  const yEnd = engineResult.portExcessReturns.slice(-win);
  let realizedAnnualizedVol = 0;
  let varGapPct = 0;
  if (yEnd.length >= 2) {
    const mean = yEnd.reduce((s, v) => s + v, 0) / yEnd.length;
    const sampleVar = yEnd.reduce((s, v) => s + (v - mean) ** 2, 0) / (yEnd.length - 1);
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
    // Log-space static alpha — null when the engine couldn't build the log
    // path (e.g. some daily portfolio simple return fell to ≤ −100 %, vanishingly
    // rare). UI falls back to simple-space when this is null.
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
          // Log-space mirror — null when no holding contributed a log stream.
          sumLog: residualStats.residualSumLog,
          meanLog: residualStats.residualMeanLog,
          tStatLog: residualStats.residualTStatLog,
          ci95HalfLog: residualStats.residualCi95HalfLog,
          annualizedVolLog: residualStats.residualAnnualizedVolLog,
          bandwidthLog: residualStats.diagnostics.bandwidthLog,
          nLog: residualStats.diagnostics.nLog,
        }
      : undefined,
    model: model as ModelPresetName,
    window: win,
    n: endFit.n,
    asOfDate,
    hasFundamentals: holdingsResult?.hasFundamentals ?? false,
    regularized: endFit.regularized,
    normalizationApplied: true,
    normalization: engineResult.normalization,
  };

  // Persist snapshot and evaluate alerts (fire-and-forget; don't block response)
  persistFactorSnapshot(portfolioId, asOfDate, engineResult)
    .then(() => evaluateFactorAlerts(portfolioId, model as ModelPresetName))
    .catch(() => {});

  return NextResponse.json(snapshot);
}
