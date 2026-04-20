/**
 * Factor-based return attribution via rolling 63-day OLS regression.
 * Also: Brinson attribution (allocation / selection effects).
 */
import { ols } from "./beta";

export interface FactorDayRow {
  date: string;
  factors: Record<string, number>; // { MKT_RF: 0.01, SMB: 0.003, ... }
  portReturn: number;
}

export interface AttributionDay {
  date: string;
  alpha: number;
  contributions: Record<string, number>; // factor → daily attribution
  actual: number;
}

/** Rolling 63d OLS attribution: factor_exposure × factor_return, residual = alpha. */
export function rollingFactorAttribution(
  rows: FactorDayRow[],
  window = 63,
): AttributionDay[] {
  const FACTORS = ["MKT_RF", "SMB", "HML", "MOM", "RMW", "CMA"] as const;

  const out: AttributionDay[] = [];

  for (let i = window; i < rows.length; i++) {
    const windowRows = rows.slice(i - window, i);
    const portReturns = windowRows.map((r) => r.portReturn);

    // Estimate exposures for each factor via OLS
    const exposures: Record<string, number> = {};
    for (const f of FACTORS) {
      const x = windowRows.map((r) => r.factors[f] ?? 0);
      const { beta } = ols(portReturns, x);
      exposures[f] = beta;
    }

    // Day i attribution
    const currentDay = rows[i];
    const contributions: Record<string, number> = {};
    let totalFactor = 0;
    for (const f of FACTORS) {
      const contrib = (exposures[f] ?? 0) * (currentDay.factors[f] ?? 0);
      contributions[f] = contrib;
      totalFactor += contrib;
    }

    out.push({
      date: currentDay.date,
      alpha: currentDay.portReturn - totalFactor,
      contributions,
      actual: currentDay.portReturn,
    });
  }

  return out;
}

/** Cumulative attribution: running sum for each factor and alpha. */
export function cumulativeAttribution(
  daily: AttributionDay[],
): Record<string, string | number>[] {
  const running: Record<string, number> = { alpha: 0 };
  return daily.map((d) => {
    running.alpha = (running.alpha ?? 0) + d.alpha;
    const point: Record<string, number | string> = {
      date: d.date,
      cumulativeAlpha: running.alpha,
    };
    for (const [f, v] of Object.entries(d.contributions)) {
      running[f] = (running[f] ?? 0) + v;
      point[`cumulative_${f}`] = running[f];
    }
    return point;
  });
}

/** Brinson attribution: allocation + selection effects per sector. */
export interface BrinsonRow {
  sector: string;
  portWeight: number;
  benchWeight: number;
  portReturn: number;
  benchReturn: number;
  allocationEffect: number;
  selectionEffect: number;
  totalEffect: number;
}

export function brinsonAttribution(
  sectors: string[],
  portWeights: number[],
  benchWeights: number[],
  portReturns: number[],
  benchReturns: number[],
): BrinsonRow[] {
  return sectors.map((sector, i) => {
    const pw = portWeights[i] ?? 0;
    const bw = benchWeights[i] ?? 0;
    const pr = portReturns[i] ?? 0;
    const br = benchReturns[i] ?? 0;
    const allocationEffect = (pw - bw) * br;
    const selectionEffect = bw * (pr - br);
    return {
      sector,
      portWeight: pw,
      benchWeight: bw,
      portReturn: pr,
      benchReturn: br,
      allocationEffect,
      selectionEffect,
      totalEffect: allocationEffect + selectionEffect,
    };
  });
}

/** Trade statistics from closed positions. */
export interface TradeStats {
  hitRate: number;
  avgWin: number;
  avgLoss: number;
  payoffRatio: number;
  avgHoldingDaysWin: number;
  avgHoldingDaysLoss: number;
  totalTrades: number;
}

export interface ClosedTrade {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
}

export function computeTradeStats(trades: ClosedTrade[]): TradeStats {
  if (!trades.length) {
    return {
      hitRate: 0,
      avgWin: 0,
      avgLoss: 0,
      payoffRatio: 0,
      avgHoldingDaysWin: 0,
      avgHoldingDaysLoss: 0,
      totalTrades: 0,
    };
  }

  const wins = trades.filter((t) => t.exitPrice > t.entryPrice);
  const losses = trades.filter((t) => t.exitPrice <= t.entryPrice);

  function holdingDays(t: ClosedTrade): number {
    return (new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime()) / (1000 * 60 * 60 * 24);
  }

  function pnlPct(t: ClosedTrade): number {
    return (t.exitPrice - t.entryPrice) / t.entryPrice;
  }

  const avgWin = wins.length ? wins.reduce((s, t) => s + pnlPct(t), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + pnlPct(t), 0) / losses.length : 0;

  return {
    hitRate: wins.length / trades.length,
    avgWin,
    avgLoss,
    payoffRatio: Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0,
    avgHoldingDaysWin: wins.length ? wins.reduce((s, t) => s + holdingDays(t), 0) / wins.length : 0,
    avgHoldingDaysLoss: losses.length ? losses.reduce((s, t) => s + holdingDays(t), 0) / losses.length : 0,
    totalTrades: trades.length,
  };
}
