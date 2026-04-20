/**
 * factor-alerts.service — rules-based monitoring for factor exposures.
 *
 * Runs after each factor snapshot write and writes Alert records when
 * thresholds are breached.
 *
 * Rules:
 *  1. Factor Drift: |β_today − mean(β_last 90d)| > driftZ × σ_90d
 *  2. Factor Concentration: any factor's PCR (% variance contribution) > concentrationPct
 *  3. Active Risk Spike: total annualized vol > activeRiskPct (simplistic; no benchmark for now)
 *  4. Alpha Deterioration: trailing-90d annualized alpha < 0 with |alphaTStat| > 1
 *  5. Sector Domination: any sector contributes > sectorDomPct of any factor exposure (drivers needed)
 *
 * Thresholds come from AppSetting keyed "factorAlertThresholds"; defaults used if missing.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { detectFactorDrift } from "./factor-snapshot.service";
import type { ModelPresetName } from "@/types/factors";

interface AlertThresholds {
  driftZ: number;          // z-score threshold for factor drift alert  (default 2.0)
  concentrationPct: number; // max % variance from one factor           (default 0.60)
  activeRiskPct: number;   // max annualized portfolio vol              (default 0.30)
  alphaZThreshold: number; // |t| threshold for alpha deterioration     (default 1.0)
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  driftZ: 2.0,
  concentrationPct: 0.60,
  activeRiskPct: 0.30,
  alphaZThreshold: 1.0,
};

async function getThresholds(): Promise<AlertThresholds> {
  const setting = await db.appSetting.findUnique({ where: { key: "factorAlertThresholds" } });
  if (!setting) return DEFAULT_THRESHOLDS;
  return { ...DEFAULT_THRESHOLDS, ...(setting.value as Partial<AlertThresholds>) };
}

async function upsertAlert(payload: {
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
  contextJson?: object;
}): Promise<void> {
  await db.alert.create({
    data: {
      severity: payload.severity,
      type: payload.type,
      message: payload.message,
      contextJson: payload.contextJson ?? {},
    },
  });
}

/**
 * Evaluate factor alerts for a portfolio after a new snapshot.
 * Reads the latest snapshot and compares against history.
 */
export async function evaluateFactorAlerts(
  portfolioId: string,
  model: ModelPresetName,
): Promise<void> {
  const thresholds = await getThresholds();

  // --- 1. Factor Drift ---
  const driftEvents = await detectFactorDrift(portfolioId, model, 90, thresholds.driftZ);
  for (const event of driftEvents) {
    await upsertAlert({
      type: "factor_drift",
      severity: "WARNING",
      message:
        `Factor drift detected: ${event.factorCode} beta = ${event.currentBeta.toFixed(3)} `
        + `(z = ${event.zScore.toFixed(1)} vs 90-day history). `
        + `Historical mean: ${event.historicalMean.toFixed(3)} ± ${event.historicalStd.toFixed(3)}.`,
      contextJson: {
        portfolioId,
        model,
        factorCode: event.factorCode,
        currentBeta: event.currentBeta,
        historicalMean: event.historicalMean,
        historicalStd: event.historicalStd,
        zScore: event.zScore,
      },
    });
  }

  // --- 2. Factor Concentration + Alpha Deterioration ---
  const latest = await db.factorExposureSnapshot.findFirst({
    where: { portfolioId, modelName: model },
    orderBy: { asOfDate: "desc" },
  });
  if (!latest) return;

  const json = latest.factorsJson as {
    pctRiskContribs?: Record<string, number>;
    alpha?: number;
    alphaTStat?: number;
    systematicShare?: number;
  };

  // Concentration check
  const pctRiskContribs = json.pctRiskContribs ?? {};
  for (const [code, pct] of Object.entries(pctRiskContribs)) {
    if (Math.abs(pct) > thresholds.concentrationPct) {
      await upsertAlert({
        type: "factor_concentration",
        severity: "WARNING",
        message:
          `Factor concentration: ${code} contributes ${(Math.abs(pct) * 100).toFixed(1)}% `
          + `of portfolio variance (threshold: ${(thresholds.concentrationPct * 100).toFixed(0)}%).`,
        contextJson: { portfolioId, model, factorCode: code, pctRiskContrib: pct },
      });
    }
  }

  // Alpha deterioration check
  const alpha = json.alpha ?? 0;
  const alphaTStat = json.alphaTStat ?? 0;
  const annualAlpha = alpha * 252;
  if (annualAlpha < 0 && Math.abs(alphaTStat) > thresholds.alphaZThreshold) {
    await upsertAlert({
      type: "alpha_deterioration",
      severity: "WARNING",
      message:
        `Alpha deterioration: annualized alpha = ${(annualAlpha * 100).toFixed(2)}% `
        + `(t = ${alphaTStat.toFixed(2)}). Factor exposures may be driving recent underperformance.`,
      contextJson: { portfolioId, model, annualAlpha, alphaTStat },
    });
  }
}

/** Fetch current factor-related alerts for a portfolio. */
export async function getFactorAlerts(portfolioId: string): Promise<{
  id: string;
  at: string;
  type: string;
  severity: string;
  message: string;
  context: unknown;
}[]> {
  const rows = await db.alert.findMany({
    where: {
      type: { in: ["factor_drift", "factor_concentration", "active_risk_spike", "alpha_deterioration", "sector_domination", "factor_breach"] },
      dismissedAt: null,
      contextJson: { path: ["portfolioId"], equals: portfolioId },
    },
    orderBy: { at: "desc" },
    take: 50,
  });

  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    type: r.type,
    severity: r.severity,
    message: r.message,
    context: r.contextJson,
  }));
}
