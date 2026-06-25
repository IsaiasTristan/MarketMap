/**
 * live-portfolio-1d.service — live 1D portfolio factor decomposition.
 *
 * Builds a weighted live portfolio return + live MACRO14 factor row and
 * applies horizon end-fit betas (same estimator as per-stock live-1d).
 * Used by the full attribution path and the lightweight poll endpoint.
 */
import { prisma as db } from "@/infrastructure/db/client";
import {
  fetchYahooQuotesWithSparkline,
  toYahooSymbol,
} from "@/infrastructure/providers/yahoo-chart-http";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import {
  factorRowLog,
  logOnePlusClipped,
} from "@/lib/factors/attribution/log-returns";
import { todayEtIsoDate } from "@/lib/factors/attribution/today-et";
import type { MarketSession } from "@/lib/market-map/market-session";
import { getLiveFactorRow } from "./live-factor-returns.service";
import { loadPortfolioWeights } from "./portfolio.service";
import { runFactorEngine } from "./factor-engine.service";
import type {
  FactorCode,
  ModelPresetName,
  PeriodAttributionSummary,
  PeriodAttributionSummaryLog,
} from "@/types/factors";

const ENGINE_CACHE_TTL_MS = 2 * 60_000;

export type LivePortfolio1DFailureReason =
  | "ENGINE_UNAVAILABLE"
  | "NO_LIVE_FACTORS"
  | "NO_POSITIONS"
  | "NO_HOLDING_QUOTES";

export interface LivePortfolio1DMeta {
  asOf: string;
  session: MarketSession;
  missingLegs: string[];
  factorsUsed: FactorCode[];
  missingHoldings: string[];
}

export interface LivePortfolio1DSuccess {
  ok: true;
  summary: PeriodAttributionSummary;
  summaryLog: PeriodAttributionSummaryLog | null;
  live1D: LivePortfolio1DMeta;
}

export interface LivePortfolio1DFailure {
  ok: false;
  reason: LivePortfolio1DFailureReason;
}

export type LivePortfolio1DResult = LivePortfolio1DSuccess | LivePortfolio1DFailure;

export interface LivePortfolio1DInput {
  portfolioId: string;
  factorCodes: FactorCode[];
  endFitBetas: number[];
  endFitDailyAlpha: number;
  endFitLogBetas: number[] | null;
  endFitLogDailyAlpha: number | null;
}

interface EngineEndFitCacheEntry {
  at: number;
  input: Omit<LivePortfolio1DInput, "portfolioId">;
}

const engineEndFitCache = new Map<string, EngineEndFitCacheEntry>();

/** Reset engine end-fit cache. Test-only. */
export function _resetLivePortfolioEngineCache(): void {
  engineEndFitCache.clear();
}

function cacheKey(portfolioId: string, model: ModelPresetName, window: number): string {
  return `${portfolioId}:${model}:${window}`;
}

/**
 * Load horizon end-fit coefficients with a short TTL so live-1d polls
 * don't re-run the full factor engine every 30s.
 */
export async function getCachedEngineEndFitInput(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
): Promise<Omit<LivePortfolio1DInput, "portfolioId"> | null> {
  const key = cacheKey(portfolioId, model, window);
  const now = Date.now();
  const hit = engineEndFitCache.get(key);
  if (hit && now - hit.at < ENGINE_CACHE_TTL_MS) {
    return hit.input;
  }

  const engineResult = await runFactorEngine({ portfolioId, model, window });
  if (!engineResult?.rollingFits.length) return null;

  const input: Omit<LivePortfolio1DInput, "portfolioId"> = {
    factorCodes: engineResult.factors,
    endFitBetas: engineResult.endFit.betas,
    endFitDailyAlpha: engineResult.endFit.alpha,
    endFitLogBetas: engineResult.endFitLog?.betas ?? null,
    endFitLogDailyAlpha: engineResult.endFitLog?.alpha ?? null,
  };
  engineEndFitCache.set(key, { at: now, input });
  return input;
}

/**
 * Compose live 1D portfolio period summaries from cached end-fit + Yahoo quotes.
 */
export async function buildLivePortfolio1D(
  input: LivePortfolio1DInput,
): Promise<LivePortfolio1DResult> {
  const liveRow = await getLiveFactorRow(new Date());
  if (!liveRow) {
    return { ok: false, reason: "NO_LIVE_FACTORS" };
  }

  const weights = await loadPortfolioWeights(db, input.portfolioId);
  if (weights.length === 0) {
    return { ok: false, reason: "NO_POSITIONS" };
  }

  const equityWeights = weights.filter((w) => !w.isCash);
  const quoteMap = await fetchYahooQuotesWithSparkline(
    equityWeights.map((w) => w.ticker),
  );

  const missingHoldings: string[] = [];
  let totalPresentGross = 0;
  let weightedReturn = 0;
  for (const w of weights) {
    if (w.isCash) {
      totalPresentGross += w.grossWeight;
      continue;
    }
    const q = quoteMap.get(toYahooSymbol(w.ticker));
    if (
      !q ||
      !Number.isFinite(q.price) ||
      !Number.isFinite(q.prevClose) ||
      q.prevClose <= 0
    ) {
      missingHoldings.push(w.ticker);
      continue;
    }
    const r = q.price / q.prevClose - 1;
    const gross = w.grossWeight;
    if (gross <= 0) continue;
    weightedReturn += (w.isShort ? -1 : 1) * gross * r;
    totalPresentGross += gross;
  }

  if (totalPresentGross <= 0) {
    return { ok: false, reason: "NO_HOLDING_QUOTES" };
  }

  const portTotal = weightedReturn / totalPresentGross;
  const rf = liveRow.rf;
  const portExcess = portTotal - rf;

  const factorsUsed: FactorCode[] = [];
  const liveFactorRowSimple: number[] = [];
  for (let fi = 0; fi < input.factorCodes.length; fi++) {
    const code = input.factorCodes[fi]!;
    const v = liveRow.returns[code];
    if (v != null && Number.isFinite(v)) {
      factorsUsed.push(code);
      liveFactorRowSimple.push(v);
    } else {
      liveFactorRowSimple.push(0);
    }
  }
  if (factorsUsed.length === 0) {
    return { ok: false, reason: "NO_LIVE_FACTORS" };
  }

  let systematic = 0;
  const byFactor: PeriodAttributionSummary["byFactor"] = [];
  for (let fi = 0; fi < input.factorCodes.length; fi++) {
    const beta = input.endFitBetas[fi] ?? 0;
    const r = liveFactorRowSimple[fi] ?? 0;
    const contrib = beta * r;
    systematic += contrib;
    const code = input.factorCodes[fi]!;
    byFactor.push({
      code,
      label: getFactorDef(code).label,
      contribution: contrib,
      pct: 0,
    });
  }
  const alphaContribution = input.endFitDailyAlpha;
  const totalReturn = portExcess + rf;
  for (const b of byFactor) {
    b.pct =
      Math.abs(totalReturn) > 1e-10 ? b.contribution / Math.abs(totalReturn) : 0;
  }

  const today = todayEtIsoDate();
  const summary: PeriodAttributionSummary = {
    label: "1D",
    startDate: today,
    endDate: today,
    totalReturn,
    factorReturn: systematic,
    rfReturn: rf,
    alpha: alphaContribution,
    byFactor,
  };

  let summaryLog: PeriodAttributionSummaryLog | null = null;
  if (input.endFitLogBetas && input.endFitLogDailyAlpha != null) {
    const xLog = factorRowLog(liveFactorRowSimple);
    const yClip = logOnePlusClipped(portTotal);
    const rfClip = logOnePlusClipped(rf);
    if (
      xLog != null &&
      Number.isFinite(yClip.value) &&
      !yClip.clipped &&
      Number.isFinite(rfClip.value)
    ) {
      const yLog = yClip.value - rfClip.value;
      const rfLog = rfClip.value;
      let factorLogReturn = 0;
      const byFactorLog: PeriodAttributionSummaryLog["byFactor"] = [];
      for (let fi = 0; fi < input.factorCodes.length; fi++) {
        const beta = input.endFitLogBetas[fi] ?? 0;
        const contrib = beta * (xLog[fi] ?? 0);
        factorLogReturn += contrib;
        const code = input.factorCodes[fi]!;
        byFactorLog.push({
          code,
          label: getFactorDef(code).label,
          contribution: contrib,
          pct: 0,
        });
      }
      const alphaLog = input.endFitLogDailyAlpha;
      for (const b of byFactorLog) {
        b.pct =
          Math.abs(yLog) > 1e-10 ? b.contribution / Math.abs(yLog) : 0;
      }
      summaryLog = {
        label: "1D",
        startDate: today,
        endDate: today,
        totalLogReturn: yLog,
        totalGeometricReturn: Math.exp(yLog) - 1,
        factorLogReturn,
        rfLogReturn: rfLog,
        alpha: alphaLog,
        byFactor: byFactorLog,
      };
    }
  }

  return {
    ok: true,
    summary,
    summaryLog,
    live1D: {
      asOf: liveRow.asOf,
      session: liveRow.session,
      missingLegs: liveRow.missingLegs,
      factorsUsed,
      missingHoldings,
    },
  };
}

/**
 * Entry point for the live-1d poll route — loads cached end-fit then builds live 1D.
 */
export async function computeLivePortfolio1D(
  portfolioId: string,
  model: ModelPresetName,
  window: number,
): Promise<LivePortfolio1DResult> {
  const endFit = await getCachedEngineEndFitInput(portfolioId, model, window);
  if (!endFit) {
    return { ok: false, reason: "ENGINE_UNAVAILABLE" };
  }
  return buildLivePortfolio1D({ portfolioId, ...endFit });
}
