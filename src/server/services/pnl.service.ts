/**
 * pnl.service — portfolio P&L, allocation, and liquidity analytics.
 *
 * Uses live price snapshots from Yahoo for current market values, and
 * stored PriceHistory for period P&L calculations.
 */

import { prisma as db } from "@/infrastructure/db/client";
import {
  fetchYahooQuotes,
} from "@/infrastructure/providers/yahoo-fundamentals";
import { toYahooSymbol } from "@/infrastructure/providers/yahoo-chart-http";
import type { PositionRow } from "./position.service";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PnlSummary {
  totalValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  mtdPnl: number;
  mtdPnlPct: number;
  qtdPnl: number;
  qtdPnlPct: number;
  ytdPnl: number;
  ytdPnlPct: number;
  snapshotDate: string;
}

export interface PositionWithPnl {
  ticker: string;
  name: string;
  sector: string | null;
  country: string | null;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  marketValue: number;
  cost: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  weight: number; // fraction of total portfolio
  adv20d: number; // 20-day avg daily volume
  daysToLiquidate: number; // position / (ADV * 0.20)
}

export interface AllocationSlice {
  name: string;
  value: number; // $ market value
  pct: number;   // fraction 0-1
}

// ── Period boundary helpers ────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isWeekend(): boolean {
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

function boundaryIso(type: "MTD" | "QTD" | "YTD"): string {
  const now = new Date();
  if (type === "MTD") return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  if (type === "QTD") {
    const q = Math.floor(now.getMonth() / 3);
    const m = String(q * 3 + 1).padStart(2, "0");
    return `${now.getFullYear()}-${m}-01`;
  }
  return `${now.getFullYear()}-01-01`;
}

// ── ADV from stored PriceHistory ─────────────────────────────────────────

async function getAdv20d(securityId: string): Promise<number> {
  const rows = await db.priceHistory.findMany({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    take: 20,
    select: { volume: true },
  });
  const vols = rows.map((r) => Number(r.volume ?? 0)).filter((v) => v > 0);
  if (!vols.length) return 0;
  return vols.reduce((s, v) => s + v, 0) / vols.length;
}

// ── Stored price for a specific date boundary ────────────────────────────

async function getPriceAt(
  securityId: string,
  date: string,
): Promise<number | null> {
  const row = await db.priceHistory.findFirst({
    where: {
      securityId,
      tradeDate: { lte: new Date(date) },
    },
    orderBy: { tradeDate: "desc" },
  });
  return row ? Number(row.adjClose) : null;
}

// ── Last two stored trading-day prices (weekend fallback) ─────────────────

async function getLastStoredPrices(
  securityId: string,
): Promise<{ currentPrice: number; prevClose: number; date: string } | null> {
  const rows = await db.priceHistory.findMany({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    take: 2,
    select: { adjClose: true, tradeDate: true },
  });
  if (rows.length < 2) return null;
  return {
    currentPrice: Number(rows[0].adjClose),
    prevClose: Number(rows[1].adjClose),
    date: rows[0].tradeDate.toISOString().slice(0, 10),
  };
}

// ── Main entry points ──────────────────────────────────────────────────────

export async function getPortfolioPnl(
  positions: PositionRow[],
): Promise<{ summary: PnlSummary; positionsWithPnl: PositionWithPnl[] }> {
  if (!positions.length) {
    const zero = {
      totalValue: 0,
      totalCost: 0,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      dailyPnl: 0,
      dailyPnlPct: 0,
      mtdPnl: 0,
      mtdPnlPct: 0,
      qtdPnl: 0,
      qtdPnlPct: 0,
      ytdPnl: 0,
      ytdPnlPct: 0,
      snapshotDate: todayIso(),
    };
    return { summary: zero, positionsWithPnl: [] };
  }

  // On weekends markets are closed — use stored prices rather than live Yahoo quotes
  const weekend = isWeekend();
  const tickers = [...new Set(positions.map((p) => p.ticker))];
  const quotes = weekend ? new Map<string, { price: number; volume: number; prevClose: number }>() : await fetchYahooQuotes(tickers);

  // Look up security IDs for DB queries
  const securities = await db.security.findMany({
    where: { ticker: { in: tickers } },
    select: { id: true, ticker: true, sector: true, country: true },
  });
  const secMap = new Map(securities.map((s) => [s.ticker, s]));

  // Period boundaries
  const mtdStart = boundaryIso("MTD");
  const qtdStart = boundaryIso("QTD");
  const ytdStart = boundaryIso("YTD");

  let totalValue = 0;
  let totalCost = 0;
  let totalMtdCostBasis = 0;
  let totalQtdCostBasis = 0;
  let totalYtdCostBasis = 0;
  let dailyPrevValue = 0;
  let mtdStartValue = 0;
  let qtdStartValue = 0;
  let ytdStartValue = 0;
  let snapshotDate = todayIso();

  const positionsWithPnl: PositionWithPnl[] = [];

  for (const pos of positions) {
    const sec = secMap.get(pos.ticker);
    const secId = sec?.id;

    // Period start prices + ADV + optional weekend stored-price lookup
    const [mtdPrice, qtdPrice, ytdPrice, adv, storedPrices] = await Promise.all([
      secId ? getPriceAt(secId, mtdStart) : null,
      secId ? getPriceAt(secId, qtdStart) : null,
      secId ? getPriceAt(secId, ytdStart) : null,
      secId ? getAdv20d(secId) : Promise.resolve(0),
      weekend && secId ? getLastStoredPrices(secId) : Promise.resolve(null),
    ]);

    let currentPrice: number;
    let prevClose: number;

    if (weekend && storedPrices) {
      currentPrice = storedPrices.currentPrice;
      prevClose = storedPrices.prevClose;
      snapshotDate = storedPrices.date; // last market close date (e.g. Friday)
    } else {
      const quote = quotes.get(toYahooSymbol(pos.ticker));
      currentPrice = quote?.price ?? pos.entryPrice;
      prevClose = quote?.prevClose ?? currentPrice;
    }

    const marketValue = pos.shares * currentPrice;
    const cost = pos.shares * pos.entryPrice;

    totalValue += marketValue;
    totalCost += cost;
    dailyPrevValue += pos.shares * prevClose;

    mtdStartValue += pos.shares * (mtdPrice ?? pos.entryPrice);
    qtdStartValue += pos.shares * (qtdPrice ?? pos.entryPrice);
    ytdStartValue += pos.shares * (ytdPrice ?? pos.entryPrice);
    totalMtdCostBasis += pos.shares * (mtdPrice ?? pos.entryPrice);
    totalQtdCostBasis += pos.shares * (qtdPrice ?? pos.entryPrice);
    totalYtdCostBasis += pos.shares * (ytdPrice ?? pos.entryPrice);

    const dailyPnl = pos.shares * (currentPrice - prevClose);
    const adv20 = adv;
    const daysToLiquidate =
      adv20 > 0 ? marketValue / (adv20 * currentPrice * 0.2) : 999;

    positionsWithPnl.push({
      ticker: pos.ticker,
      name: pos.name,
      sector: pos.sector ?? sec?.sector ?? null,
      country: sec?.country ?? null,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      currentPrice,
      marketValue,
      cost,
      unrealizedPnl: marketValue - cost,
      unrealizedPnlPct: cost > 0 ? (marketValue - cost) / cost : 0,
      dailyPnl,
      dailyPnlPct: prevClose > 0 ? (currentPrice - prevClose) / prevClose : 0,
      weight: 0, // filled after totals known
      adv20d: adv20,
      daysToLiquidate,
    });
  }

  // Fill weights
  for (const p of positionsWithPnl) {
    p.weight = totalValue > 0 ? p.marketValue / totalValue : 0;
  }

  const dailyPnl = totalValue - dailyPrevValue;
  const mtdPnl = totalValue - mtdStartValue;
  const qtdPnl = totalValue - qtdStartValue;
  const ytdPnl = totalValue - ytdStartValue;

  const summary: PnlSummary = {
    totalValue,
    totalCost,
    unrealizedPnl: totalValue - totalCost,
    unrealizedPnlPct: totalCost > 0 ? (totalValue - totalCost) / totalCost : 0,
    dailyPnl,
    dailyPnlPct: dailyPrevValue > 0 ? dailyPnl / dailyPrevValue : 0,
    mtdPnl,
    mtdPnlPct: mtdStartValue > 0 ? mtdPnl / mtdStartValue : 0,
    qtdPnl,
    qtdPnlPct: qtdStartValue > 0 ? qtdPnl / qtdStartValue : 0,
    ytdPnl,
    ytdPnlPct: ytdStartValue > 0 ? ytdPnl / ytdStartValue : 0,
    snapshotDate,
  };

  return { summary, positionsWithPnl };
}

// ── Allocation ─────────────────────────────────────────────────────────────

export function getAllocationByPosition(
  positions: PositionWithPnl[],
): AllocationSlice[] {
  return positions.map((p) => ({
    name: p.ticker,
    value: p.marketValue,
    pct: p.weight,
  }));
}

export function getAllocationBySector(
  positions: PositionWithPnl[],
): AllocationSlice[] {
  const map = new Map<string, number>();
  const total = positions.reduce((s, p) => s + p.marketValue, 0);
  for (const p of positions) {
    const sector = p.sector ?? "Other";
    map.set(sector, (map.get(sector) ?? 0) + p.marketValue);
  }
  return Array.from(map.entries()).map(([name, value]) => ({
    name,
    value,
    pct: total > 0 ? value / total : 0,
  }));
}

export function getAllocationByGeography(
  positions: PositionWithPnl[],
): AllocationSlice[] {
  const map = new Map<string, number>();
  const total = positions.reduce((s, p) => s + p.marketValue, 0);
  for (const p of positions) {
    const geo = p.country ?? "US";
    map.set(geo, (map.get(geo) ?? 0) + p.marketValue);
  }
  return Array.from(map.entries()).map(([name, value]) => ({
    name,
    value,
    pct: total > 0 ? value / total : 0,
  }));
}

// ── Top Contributors / Detractors ─────────────────────────────────────────

export function getContributors(
  positions: PositionWithPnl[],
  n = 5,
): { contributors: PositionWithPnl[]; detractors: PositionWithPnl[] } {
  const sorted = [...positions].sort((a, b) => b.dailyPnl - a.dailyPnl);
  return {
    contributors: sorted.slice(0, n),
    detractors: sorted.slice(-n).reverse(),
  };
}
