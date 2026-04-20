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
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorExposureSnapshot, FactorCode, ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = factorQueryParams.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, ew } = parsed.data;

  const [engineResult, holdingsResult] = await Promise.all([
    runFactorEngine({ portfolioId, model: model as ModelPresetName, window: win, ewHalfLife: ew }),
    computeFactorExposures(portfolioId).catch(() => null),
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

  // Concentration HHI on absolute risk contributions
  const totalAbsPCR = risk.factors.reduce((s, f) => s + Math.abs(f.pctVarianceContrib), 0);
  const concentrationHHI = totalAbsPCR > 0
    ? risk.factors.reduce((s, f) => s + (Math.abs(f.pctVarianceContrib) / totalAbsPCR) ** 2, 0)
    : 0;

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
    rSquared: endFit.rSquared,
    adjRSquared: endFit.adjRSquared,
    concentrationHHI,
    systematicShare: risk.systematicShare,
    idiosyncraticShare: risk.idiosyncraticShare,
    model: model as ModelPresetName,
    window: win,
    n: endFit.n,
    asOfDate,
    hasFundamentals: holdingsResult?.hasFundamentals ?? false,
    regularized: endFit.regularized,
  };

  // Persist snapshot and evaluate alerts (fire-and-forget; don't block response)
  persistFactorSnapshot(portfolioId, asOfDate, engineResult)
    .then(() => evaluateFactorAlerts(portfolioId, model as ModelPresetName))
    .catch(() => {});

  return NextResponse.json(snapshot);
}
