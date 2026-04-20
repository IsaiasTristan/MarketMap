/**
 * data-refresh.service — top-level orchestrator for all data sources.
 * Runs: benchmark prices → portfolio security prices → FRED risk-free rate → alerts.
 * Called from the /api/analysis/data/refresh route.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { writeAuditLog } from "./audit.service";
import { generateAlerts } from "./alerts.service";
import { fetchLatestRiskFreeRate } from "@/infrastructure/providers/fred.provider";
import { ingestBenchmarkHistory, ingestSecurityHistory } from "./price-ingest.service";
import { runFactorEngine } from "./factor-engine.service";
import { persistFactorSnapshot } from "./factor-snapshot.service";
import { evaluateFactorAlerts } from "./factor-alerts.service";

export interface RefreshResult {
  benchmarkBarsIngested: number;
  pricesIngested: number;
  rfRateUpdated: boolean;
  factorPipelineRun: boolean;
  alertsGenerated: boolean;
  errors: string[];
  durationMs: number;
}

export async function runFullRefresh(portfolioId?: string): Promise<RefreshResult> {
  const start = Date.now();
  const errors: string[] = [];
  let pricesIngested = 0;
  let benchmarkBarsIngested = 0;
  let rfRateUpdated = false;
  const factorPipelineRun = false;
  let alertsGenerated = false;

  // 1. Ingest 10 years of benchmark price history (SP500, NASDAQ, DOW) — always runs.
  //    This is what powers vol decomposition and beta calculations.
  for (const code of ["SP500", "NASDAQ", "DOW"] as const) {
    try {
      const result = await ingestBenchmarkHistory(db, code, 10);
      benchmarkBarsIngested += result.bars;
    } catch (e) {
      errors.push(`Benchmark ${code} ingest failed: ${(e as Error).message}`);
    }
  }

  // 2. Ingest 10 years of price history for every open position in the portfolio.
  if (portfolioId) {
    try {
      const positions = await db.portfolioPosition.findMany({
        where: { portfolioId, closedAt: null },
        include: { security: true },
        distinct: ["securityId"],
      });
      for (const pos of positions) {
        try {
          const result = await ingestSecurityHistory(db, pos.security.ticker, 10);
          pricesIngested += result.bars;
        } catch (e) {
          errors.push(`Price ingest ${pos.security.ticker}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`Portfolio position query failed: ${(e as Error).message}`);
    }
  }

  // 3. Update risk-free rate from FRED
  try {
    const rfRate = await fetchLatestRiskFreeRate();
    await db.riskFreeRate.upsert({
      where: { tradeDate: new Date(new Date().toISOString().slice(0, 10)) },
      create: {
        tradeDate: new Date(new Date().toISOString().slice(0, 10)),
        annualRate: rfRate,
      },
      update: { annualRate: rfRate },
    });
    rfRateUpdated = true;
  } catch (e) {
    errors.push(`FRED RF rate failed: ${(e as Error).message}`);
  }

  // 4. Generate alerts if portfolio available
  if (portfolioId) {
    try {
      await generateAlerts(portfolioId);
      alertsGenerated = true;
    } catch (e) {
      errors.push(`Alert generation failed: ${(e as Error).message}`);
    }
  }

  // 5. Persist factor exposure snapshot (FF5 default) for history and drift detection
  if (portfolioId) {
    try {
      const engineResult = await runFactorEngine({ portfolioId, model: "FF5", window: 252 });
      if (engineResult) {
        const asOfDate = engineResult.dates[engineResult.dates.length - 1] ?? new Date().toISOString().slice(0, 10);
        await persistFactorSnapshot(portfolioId, asOfDate, engineResult);
        await evaluateFactorAlerts(portfolioId, "FF5");
      }
    } catch (e) {
      errors.push(`Factor snapshot failed: ${(e as Error).message}`);
    }
  }

  const result: RefreshResult = {
    benchmarkBarsIngested,
    pricesIngested,
    rfRateUpdated,
    factorPipelineRun,
    alertsGenerated,
    errors,
    durationMs: Date.now() - start,
  };

  await writeAuditLog("data.refresh.completed", { ...result, portfolioId });
  return result;
}
