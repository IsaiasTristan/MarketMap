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
  /** Gross capital deployed: Σ |shares × current price|. */
  totalValue: number;
  /** Net market value: Σ signed_shares × current price (longs − shorts). */
  netValue: number;
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
  isShort: boolean;
  currentPrice: number;
  /** Gross market value: |shares × price|. Always positive. */
  marketValue: number;
  /** Daily P&L in dollars, sign-adjusted for L/S (gain when short and price drops). */
  dailyPnl: number;
  /** Daily P&L as a fraction of the position's gross market value. */
  dailyPnlPct: number;
  /** Gross weight: |market value| / Σ |market value|. */
  weight: number;
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
    const zero: PnlSummary = {
      totalValue: 0,
      netValue: 0,
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

  // totalValue is GROSS (sums |shares × price|) — used as the dollar base
  // for weights and as the headline "capital deployed" tile.
  // netValue is signed (longs − shorts) — the mark-to-market NAV.
  let totalValue = 0;
  let netValue = 0;
  // Period anchors are tracked as net values (signed) so that P&L = current
  // net − prior net correctly inverts for shorts.
  let netDailyPrev = 0;
  let netMtdStart = 0;
  let netQtdStart = 0;
  let netYtdStart = 0;
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
      currentPrice = quote?.price ?? 0;
      prevClose = quote?.prevClose ?? currentPrice;
    }

    // Direction sign: short positions invert P&L (gain when price drops).
    const sign = pos.isShort ? -1 : 1;
    const grossMv = Math.abs(pos.shares * currentPrice);
    const signedMv = sign * pos.shares * currentPrice;

    totalValue += grossMv;
    netValue += signedMv;
    netDailyPrev += sign * pos.shares * prevClose;

    // Period-start prices fall back to current price when no history exists,
    // so a brand-new position starts with 0 period P&L instead of NaN.
    netMtdStart += sign * pos.shares * (mtdPrice ?? currentPrice);
    netQtdStart += sign * pos.shares * (qtdPrice ?? currentPrice);
    netYtdStart += sign * pos.shares * (ytdPrice ?? currentPrice);

    const dailyPnl = sign * pos.shares * (currentPrice - prevClose);
    const adv20 = adv;
    const daysToLiquidate =
      adv20 > 0 ? grossMv / (adv20 * currentPrice * 0.2) : 999;

    positionsWithPnl.push({
      ticker: pos.ticker,
      name: pos.name,
      sector: pos.sector ?? sec?.sector ?? null,
      country: sec?.country ?? null,
      shares: pos.shares,
      isShort: pos.isShort,
      currentPrice,
      marketValue: grossMv,
      dailyPnl,
      dailyPnlPct: prevClose > 0 ? sign * (currentPrice - prevClose) / prevClose : 0,
      weight: 0, // filled after totals known
      adv20d: adv20,
      daysToLiquidate,
    });
  }

  // Gross weights for display — sum to 1, direction-agnostic.
  for (const p of positionsWithPnl) {
    p.weight = totalValue > 0 ? p.marketValue / totalValue : 0;
  }

  const dailyPnl = netValue - netDailyPrev;
  const mtdPnl = netValue - netMtdStart;
  const qtdPnl = netValue - netQtdStart;
  const ytdPnl = netValue - netYtdStart;

  // P&L percentages anchor to gross capital (totalValue) — for a market-
  // neutral book net values can be ~0, so anchoring to net would blow up.
  const summary: PnlSummary = {
    totalValue,
    netValue,
    dailyPnl,
    dailyPnlPct: totalValue > 0 ? dailyPnl / totalValue : 0,
    mtdPnl,
    mtdPnlPct: totalValue > 0 ? mtdPnl / totalValue : 0,
    qtdPnl,
    qtdPnlPct: totalValue > 0 ? qtdPnl / totalValue : 0,
    ytdPnl,
    ytdPnlPct: totalValue > 0 ? ytdPnl / totalValue : 0,
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
