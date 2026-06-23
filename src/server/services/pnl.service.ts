/**
 * pnl.service — portfolio P&L, allocation, and liquidity analytics.
 *
 * Uses live price snapshots from Yahoo for current market values, and
 * stored PriceHistory for period P&L calculations.
 */

import { prisma as db } from "@/infrastructure/db/client";
import {
  fetchYahooQuotesViaChart,
  toYahooSymbol,
} from "@/infrastructure/providers/yahoo-chart-http";
import type { PositionRow } from "./position.service";
import { computePositionRisk } from "./risk.service";

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

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a position's sector across the three sources we keep, in priority
 * order: the user-curated universe tag wins, then the position's manual
 * override, then the Yahoo profile fallback. Exported for direct testing of
 * the priority chain (the Sector toggle on the Capital Allocation donut
 * relies on this resolving to a real sector instead of collapsing to "Other").
 */
export function resolveSector(
  universeSector: string | null | undefined,
  positionSector: string | null | undefined,
  securitySector: string | null | undefined,
): string | null {
  return universeSector ?? positionSector ?? securitySector ?? null;
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

/** Calendar start date for MTD / QTD / YTD period lookups. */
export function periodBoundaryIso(type: "MTD" | "QTD" | "YTD"): string {
  return boundaryIso(type);
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

  // On weekends markets are closed — use stored prices rather than live Yahoo quotes.
  // Weekdays use the v8 chart endpoint (v7 /quote returns 401 without a session crumb).
  const weekend = isWeekend();
  const tickers = [...new Set(positions.map((p) => p.ticker))];
  const quotes = weekend
    ? new Map<string, { price: number; prevClose: number }>()
    : await fetchYahooQuotesViaChart(tickers);

  // Look up security IDs for DB queries
  const securities = await db.security.findMany({
    where: { ticker: { in: tickers } },
    select: { id: true, ticker: true, sector: true, country: true },
  });
  const secMap = new Map(securities.map((s) => [s.ticker, s]));

  // Universe tags are the user-curated source of truth for sector grouping
  // (security.sector is the Yahoo profile fallback). Loading by securityId
  // matches factor-drivers.service.ts.
  const universeRows = await db.universeConstituent.findMany({
    where: { securityId: { in: securities.map((s) => s.id) } },
    select: { securityId: true, sector: true },
  });
  const universeSectorBySecId = new Map(
    universeRows.map((r) => [r.securityId, r.sector]),
  );

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

    // Period start prices + ADV + stored-price fallback (weekends + missing live quotes)
    const [mtdPrice, qtdPrice, ytdPrice, adv, storedPrices] = await Promise.all([
      secId ? getPriceAt(secId, mtdStart) : null,
      secId ? getPriceAt(secId, qtdStart) : null,
      secId ? getPriceAt(secId, ytdStart) : null,
      secId ? getAdv20d(secId) : Promise.resolve(0),
      secId ? getLastStoredPrices(secId) : Promise.resolve(null),
    ]);

    let currentPrice: number;
    let prevClose: number;

    if (weekend && storedPrices) {
      currentPrice = storedPrices.currentPrice;
      prevClose = storedPrices.prevClose;
      snapshotDate = storedPrices.date; // last market close date (e.g. Friday)
    } else {
      const quote = quotes.get(toYahooSymbol(pos.ticker));
      if (quote) {
        currentPrice = quote.price;
        prevClose = quote.prevClose;
      } else if (storedPrices) {
        currentPrice = storedPrices.currentPrice;
        prevClose = storedPrices.prevClose;
        snapshotDate = storedPrices.date;
      } else {
        currentPrice = 0;
        prevClose = 0;
      }
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

    const universeSector = secId ? universeSectorBySecId.get(secId) : null;

    positionsWithPnl.push({
      ticker: pos.ticker,
      name: pos.name,
      sector: resolveSector(universeSector, pos.sector, sec?.sector),
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

// ── Return / Risk allocation by horizon ───────────────────────────────────

export type AllocationHorizon = "1D" | "5D" | "1M" | "6M" | "1Y" | "2Y" | "5Y";

/** Custom horizons for the Overview holdings table dropdown. */
export type HoldingsHorizon = "10D" | "30D" | "3M" | "6M" | "1Y" | "2Y" | "5Y";

export const HOLDINGS_HORIZONS: HoldingsHorizon[] = [
  "10D",
  "30D",
  "3M",
  "6M",
  "1Y",
  "2Y",
  "5Y",
];

export const ALLOCATION_HORIZONS: AllocationHorizon[] = [
  "1D",
  "5D",
  "1M",
  "6M",
  "1Y",
  "2Y",
  "5Y",
];

/**
 * Trading-day count per horizon, used as the time index for sqrt(t)
 * VaR scaling. Assumes returns are i.i.d.; matches the classic
 * Basel-style horizon extension.
 */
const HORIZON_TRADING_DAYS: Record<AllocationHorizon, number> = {
  "1D": 1,
  "5D": 5,
  "1M": 21,
  "6M": 126,
  "1Y": 252,
  "2Y": 504,
  "5Y": 1260,
};

/**
 * Calendar offset used to look up the start-of-horizon close from
 * stored PriceHistory via `getPriceAt`, which floors to the most recent
 * trading day on or before the cutoff. 5D uses 7 calendar days to
 * cross a weekend; 1Y / 2Y / 5Y use simple 365-day years.
 */
const HORIZON_CALENDAR_DAYS: Record<AllocationHorizon, number> = {
  "1D": 1,
  "5D": 7,
  "1M": 30,
  "6M": 180,
  "1Y": 365,
  "2Y": 730,
  "5Y": 1825,
};

const HOLDINGS_HORIZON_CALENDAR_DAYS: Record<HoldingsHorizon, number> = {
  "10D": 14,
  "30D": 42,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "2Y": 730,
  "5Y": 1825,
};

export function holdingsHorizonStartDateIso(
  horizon: HoldingsHorizon,
  refDate: Date = new Date(),
): string {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() - HOLDINGS_HORIZON_CALENDAR_DAYS[horizon]);
  return d.toISOString().slice(0, 10);
}

export function isValidHoldingsHorizon(h: string): h is HoldingsHorizon {
  return (HOLDINGS_HORIZONS as string[]).includes(h);
}

export function scaleVarToHorizon(
  var1d: number,
  horizon: AllocationHorizon,
): number {
  return var1d * Math.sqrt(HORIZON_TRADING_DAYS[horizon]);
}

export function horizonStartDateIso(
  horizon: AllocationHorizon,
  refDate: Date = new Date(),
): string {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() - HORIZON_CALENDAR_DAYS[horizon]);
  return d.toISOString().slice(0, 10);
}

export interface ReturnSlice {
  /** Ticker, used as the pie-slice key. */
  name: string;
  /** Absolute return percent — drives the slice arc length. */
  value: number;
  /** Signed return percent (negative when the position lost money). */
  signed: number;
  /** True when `signed < 0`; the UI draws a red outline on negative slices. */
  negative: boolean;
  /** Gross market value at the end of the horizon, for legend context. */
  marketValue: number;
}

export interface RiskSlice {
  name: string;
  /** Dollar VaR over the horizon (already sqrt-time scaled). Always >= 0. */
  value: number;
  /** Share of total horizon VaR. */
  pct: number;
  /** Same as `value` — explicit alias for legend clarity. */
  dollar: number;
  /** Shorts contribute risk too — risk slices are never marked negative. */
  negative: false;
  marketValue: number;
}

export interface ReturnRiskAllocation {
  horizon: AllocationHorizon;
  byReturn: ReturnSlice[];
  byRisk: RiskSlice[];
  totals: {
    /** Gross-weighted portfolio return over the horizon (signed). */
    returnPct: number;
    /** Dollar P&L over the horizon (signed). */
    returnDollar: number;
    /** Total horizon VaR in dollars. */
    varDollar: number;
    /** Total horizon VaR as a fraction of gross capital. */
    varPct: number;
    grossValue: number;
  };
}

/**
 * Per-position return + risk slices for the Capital Allocation donut.
 *
 * Return slices are sized by absolute return % so the donut always closes,
 * with `negative` set when the signed return is < 0 so the UI can outline
 * the slice in red.
 *
 * Risk slices reuse `computePositionRisk`'s 1-day 95% parametric VaR per
 * position and scale to the requested horizon via sqrt(trading days). This
 * is the classic i.i.d. assumption; it intentionally does not re-estimate
 * vol over the horizon window (per the plan: "Risk = 1-day VaR scaled by
 * sqrt(time)").
 *
 * Price sourcing per horizon:
 *  - 1D weekday: live Yahoo quote (current) and Yahoo prevClose (start).
 *  - 1D weekend: last two stored closes.
 *  - 5D+ : most recent stored close (current) and `getPriceAt(cutoff)` (start).
 */
export async function getReturnRiskAllocation(
  portfolioId: string,
  horizon: AllocationHorizon,
): Promise<ReturnRiskAllocation> {
  const positions = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
  });

  const empty: ReturnRiskAllocation = {
    horizon,
    byReturn: [],
    byRisk: [],
    totals: {
      returnPct: 0,
      returnDollar: 0,
      varDollar: 0,
      varPct: 0,
      grossValue: 0,
    },
  };

  if (!positions.length) return empty;

  const weekend = isWeekend();
  const tickers = positions.map((p) => p.security.ticker);
  const quotes =
    horizon === "1D" && !weekend ? await fetchYahooQuotesViaChart(tickers) : null;

  // Single risk pass per request — sqrt-time scaling below derives every
  // horizon's VaR from the 1-day baseline without re-fitting volatility.
  const risk = await computePositionRisk(portfolioId);
  const riskByTicker = new Map(risk.positions.map((r) => [r.ticker, r]));
  const scale = Math.sqrt(HORIZON_TRADING_DAYS[horizon]);

  const startCutoff = horizon === "1D" ? null : horizonStartDateIso(horizon);

  const byReturn: ReturnSlice[] = [];
  const byRisk: RiskSlice[] = [];
  let grossValue = 0;
  let returnDollar = 0;
  let totalVar = 0;

  for (const pos of positions) {
    const shares = Number(pos.shares);
    const ticker = pos.security.ticker;
    const sign = pos.isShort ? -1 : 1;

    let currentPrice = 0;
    let startPrice = 0;

    if (horizon === "1D") {
      if (weekend) {
        const stored = await getLastStoredPrices(pos.securityId);
        if (stored) {
          currentPrice = stored.currentPrice;
          startPrice = stored.prevClose;
        }
      } else {
        const q = quotes?.get(toYahooSymbol(ticker));
        if (q) {
          currentPrice = q.price;
          startPrice = q.prevClose;
        } else {
          const stored = await getLastStoredPrices(pos.securityId);
          if (stored) {
            currentPrice = stored.currentPrice;
            startPrice = stored.prevClose;
          }
        }
      }
    } else {
      const [latest, startRow] = await Promise.all([
        db.priceHistory.findFirst({
          where: { securityId: pos.securityId },
          orderBy: { tradeDate: "desc" },
          select: { adjClose: true },
        }),
        getPriceAt(pos.securityId, startCutoff!),
      ]);
      currentPrice = latest ? Number(latest.adjClose) : 0;
      startPrice = startRow ?? currentPrice;
    }

    const marketValue = Math.abs(shares * currentPrice);
    grossValue += marketValue;

    const retPctSigned =
      startPrice > 0 ? (sign * (currentPrice - startPrice)) / startPrice : 0;
    returnDollar += sign * shares * (currentPrice - startPrice);

    byReturn.push({
      name: ticker,
      value: Math.abs(retPctSigned),
      signed: retPctSigned,
      negative: retPctSigned < 0,
      marketValue,
    });

    const var1d = riskByTicker.get(ticker)?.varDollar95 ?? 0;
    const varH = var1d * scale;
    totalVar += varH;
    byRisk.push({
      name: ticker,
      value: varH,
      pct: 0,
      dollar: varH,
      negative: false,
      marketValue,
    });
  }

  for (const r of byRisk) {
    r.pct = totalVar > 0 ? r.value / totalVar : 0;
  }

  // Gross-weighted return so longs and shorts net correctly against
  // gross capital deployed (matches PnlSummary's anchoring convention).
  const returnPct = grossValue > 0 ? returnDollar / grossValue : 0;
  const varPct = grossValue > 0 ? totalVar / grossValue : 0;

  return {
    horizon,
    byReturn,
    byRisk,
    totals: { returnPct, returnDollar, varDollar: totalVar, varPct, grossValue },
  };
}
