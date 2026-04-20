import { NextResponse } from "next/server";
import { prisma as db } from "@/infrastructure/db/client";

export async function GET() {
  const [latestPrice, rfRate, factorStatus] = await Promise.all([
    db.priceHistory.findFirst({ orderBy: { tradeDate: "desc" }, select: { tradeDate: true } }),
    db.riskFreeRate.findFirst({ orderBy: { tradeDate: "desc" }, select: { tradeDate: true, annualRate: true } }),
    db.factorPipelineStatus.findFirst(),
  ]);

  return NextResponse.json({
    prices: {
      lastUpdated: latestPrice?.tradeDate?.toISOString().slice(0, 10) ?? null,
      source: "Yahoo Finance",
    },
    riskFreeRate: {
      lastUpdated: rfRate?.tradeDate?.toISOString().slice(0, 10) ?? null,
      value: rfRate ? Number(rfRate.annualRate) : null,
      source: "FRED TB3MS",
    },
    factors: {
      lastFrenchDate: factorStatus?.lastFrenchDate?.toISOString().slice(0, 10) ?? null,
      gapTradingDays: factorStatus?.gapTradingDays ?? null,
      lastRefreshAt: factorStatus?.lastRefreshAt?.toISOString() ?? null,
      source: "Fama-French + ETF Proxies",
    },
    auditLog: await db.auditLog.findMany({
      orderBy: { at: "desc" },
      take: 50,
    }),
  });
}
