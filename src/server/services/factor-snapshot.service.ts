/**
 * factor-snapshot.service — persists FactorExposureSnapshot rows and reads
 * rolling history for the exposure time-series chart.
 *
 * Snapshots store the end-of-period factor betas + diagnostics for a given
 * (portfolioId, asOfDate, modelName) combination. They power:
 *   - The "Exposure Over Time" chart (history API)
 *   - Drift alert detection (alerts service)
 */
import type { Prisma } from "@prisma/client";
import { prisma as db } from "@/infrastructure/db/client";
import type { FactorEngineResult } from "@/types/factors";

interface SnapshotJson {
  betas: Record<string, number>;
  tStats: Record<string, number>;
  alpha: number;
  alphaTStat: number;
  rSquared: number;
  adjRSquared: number;
  systematicShare: number;
  idiosyncraticShare: number;
  pctRiskContribs: Record<string, number>;
}

/**
 * Persist a factor exposure snapshot (idempotent on portfolioId + asOfDate + modelName).
 * Called after every successful exposure computation.
 */
export async function persistFactorSnapshot(
  portfolioId: string,
  asOfDate: string,
  engineResult: FactorEngineResult,
): Promise<void> {
  const { endFit, risk, factors: factorCodes, model } = engineResult;
  const dateObj = new Date(asOfDate);

  const betasRecord: Record<string, number> = {};
  const tStatsRecord: Record<string, number> = {};
  const pctRiskContribs: Record<string, number> = {};

  for (let i = 0; i < factorCodes.length; i++) {
    const code = factorCodes[i]!;
    betasRecord[code] = endFit.betas[i] ?? 0;
    tStatsRecord[code] = endFit.tStats[i] ?? 0;
  }
  for (const f of risk.factors) {
    pctRiskContribs[f.code] = f.pctVarianceContrib;
  }

  const factorsJson: SnapshotJson = {
    betas: betasRecord,
    tStats: tStatsRecord,
    alpha: endFit.alpha,
    alphaTStat: endFit.alphaTStat,
    rSquared: endFit.rSquared,
    adjRSquared: endFit.adjRSquared,
    systematicShare: risk.systematicShare,
    idiosyncraticShare: risk.idiosyncraticShare,
    pctRiskContribs,
  };

  // Idempotent: find existing row for this portfolio + date + model
  const existing = await db.factorExposureSnapshot.findFirst({
    where: { portfolioId, asOfDate: dateObj, modelName: model },
    select: { id: true },
  });

  const json = factorsJson as unknown as Prisma.InputJsonValue;
  if (existing) {
    await db.factorExposureSnapshot.update({
      where: { id: existing.id },
      data: { factorsJson: json },
    });
  } else {
    await db.factorExposureSnapshot.create({
      data: { portfolioId, asOfDate: dateObj, modelName: model, factorsJson: json },
    });
  }
}

/**
 * Read the rolling exposure history for a portfolio.
 * Returns up to `limit` most-recent snapshots ordered ascending by date.
 */
export async function getExposureHistory(
  portfolioId: string,
  model: string,
  limit = 252,
): Promise<{
  dates: string[];
  series: Record<string, number[]>;
  alphas: number[];
  rSquareds: number[];
}> {
  const rows = await db.factorExposureSnapshot.findMany({
    where: { portfolioId, modelName: model },
    orderBy: { asOfDate: "asc" },
    take: limit,
  });

  const dates: string[] = [];
  const series: Record<string, number[]> = {};
  const alphas: number[] = [];
  const rSquareds: number[] = [];

  for (const row of rows) {
    dates.push(row.asOfDate.toISOString().slice(0, 10));
    const json = row.factorsJson as unknown as SnapshotJson;
    alphas.push(json.alpha ?? 0);
    rSquareds.push(json.rSquared ?? 0);
    for (const [code, beta] of Object.entries(json.betas ?? {})) {
      if (!series[code]) series[code] = [];
      series[code]!.push(beta);
    }
  }

  return { dates, series, alphas, rSquareds };
}

/**
 * Detect factor drift events in the rolling history for alert evaluation.
 * Returns a list of dates + factors where |Δβ| > threshold×σ_window.
 */
export interface DriftEvent {
  date: string;
  factorCode: string;
  currentBeta: number;
  historicalMean: number;
  historicalStd: number;
  zScore: number;
}

export async function detectFactorDrift(
  portfolioId: string,
  model: string,
  lookback = 90,
  zThreshold = 2.0,
): Promise<DriftEvent[]> {
  const rows = await db.factorExposureSnapshot.findMany({
    where: { portfolioId, modelName: model },
    orderBy: { asOfDate: "asc" },
    take: lookback + 1,
  });

  if (rows.length < 10) return [];

  // Use last row as "current", rest as history
  const current = rows[rows.length - 1]!;
  const history = rows.slice(0, -1);
  const currentJson = current.factorsJson as unknown as SnapshotJson;
  const currentBetas = currentJson.betas ?? {};

  const events: DriftEvent[] = [];

  for (const [code, currentBeta] of Object.entries(currentBetas)) {
    const historicalBetas = history
      .map((r) => ((r.factorsJson as unknown as SnapshotJson).betas ?? {})[code] ?? null)
      .filter((v): v is number => v !== null);

    if (historicalBetas.length < 5) continue;

    const mean = historicalBetas.reduce((s, v) => s + v, 0) / historicalBetas.length;
    const variance = historicalBetas.reduce((s, v) => s + (v - mean) ** 2, 0) / (historicalBetas.length - 1);
    const std = Math.sqrt(variance);

    if (std < 1e-8) continue;
    const z = (currentBeta - mean) / std;

    if (Math.abs(z) > zThreshold) {
      events.push({
        date: current.asOfDate.toISOString().slice(0, 10),
        factorCode: code,
        currentBeta,
        historicalMean: mean,
        historicalStd: std,
        zScore: z,
      });
    }
  }

  return events;
}
