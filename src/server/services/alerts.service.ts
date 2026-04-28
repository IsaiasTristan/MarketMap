/**
 * alerts.service — generates and retrieves portfolio risk alerts.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { currentDrawdown, maxDrawdown } from "@/domain/calculations/risk-adjusted";
import { writeAuditLog } from "./audit.service";

interface AlertThresholds {
  drawdownWarn: number;  // default -0.03
  drawdownCritical: number; // default -0.07
  stopLoss: number;      // default -0.10
  factorToleranceBand: number; // default 0.5
  crowdingShortRatio: number; // default 5
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  drawdownWarn: -0.03,
  drawdownCritical: -0.07,
  stopLoss: -0.10,
  factorToleranceBand: 0.5,
  crowdingShortRatio: 5,
};

async function getThresholds(portfolioId: string): Promise<AlertThresholds> {
  const setting = await db.appSetting.findUnique({ where: { key: "alertThresholds" } });
  if (!setting) return DEFAULT_THRESHOLDS;
  return { ...DEFAULT_THRESHOLDS, ...(setting.value as Partial<AlertThresholds>) };
}

export async function generateAlerts(portfolioId: string): Promise<void> {
  const thresholds = await getThresholds(portfolioId);
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });

  // 1. Portfolio drawdown alert
  const secIds = positions.map((p) => p.securityId);
  if (secIds.length > 0) {
    const priceHistory = await db.priceHistory.findMany({
      where: { securityId: secIds[0] },
      orderBy: { tradeDate: "desc" },
      take: 253,
      select: { adjClose: true },
    });
    const rets = dailyReturnsFromAdjustedCloses(priceHistory.reverse().map((r) => Number(r.adjClose)));
    const curDD = currentDrawdown(rets);

    if (curDD <= thresholds.drawdownCritical) {
      await db.alert.create({
        data: {
          severity: "CRITICAL",
          type: "drawdown",
          message: `Portfolio drawdown has reached ${(curDD * 100).toFixed(1)}% from peak (critical threshold: ${(thresholds.drawdownCritical * 100).toFixed(0)}%)`,
          contextJson: { currentDrawdown: curDD, threshold: thresholds.drawdownCritical },
        },
      });
    } else if (curDD <= thresholds.drawdownWarn) {
      await db.alert.create({
        data: {
          severity: "WARNING",
          type: "drawdown",
          message: `Portfolio drawdown has reached ${(curDD * 100).toFixed(1)}% from peak (warn threshold: ${(thresholds.drawdownWarn * 100).toFixed(0)}%)`,
          contextJson: { currentDrawdown: curDD, threshold: thresholds.drawdownWarn },
        },
      });
    }
  }

  // 2. Per-position alerts
  // (Cost-basis stop-loss removed — no entry price tracked; the portfolio-
  // level drawdown alert above covers material downside moves.)
  for (const pos of positions) {
    // Crowding via shortRatio
    const fund = await db.securityFundamentals.findFirst({
      where: { securityId: pos.securityId },
      orderBy: { asOfDate: "desc" },
      select: { shortRatio: true },
    });
    if (fund?.shortRatio && Number(fund.shortRatio) > thresholds.crowdingShortRatio) {
      await db.alert.create({
        data: {
          severity: "INFO",
          type: "crowding",
          message: `${pos.security.ticker} has high short interest ratio: ${Number(fund.shortRatio).toFixed(1)} days to cover (threshold: ${thresholds.crowdingShortRatio})`,
          contextJson: { ticker: pos.security.ticker, shortRatio: Number(fund.shortRatio) },
        },
      });
    }
  }

  await writeAuditLog("alerts.generated", { portfolioId });
}

export async function getAlerts(dismissed = false) {
  return db.alert.findMany({
    where: { dismissedAt: dismissed ? { not: null } : null },
    orderBy: { at: "desc" },
    take: 100,
  });
}

export async function dismissAlert(id: string): Promise<void> {
  await db.alert.update({ where: { id }, data: { dismissedAt: new Date() } });
}
