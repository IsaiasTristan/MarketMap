/**
 * Market factor context: per-factor returns, annualized volatility, Sharpe ratio
 * over standard horizons, computed from FactorReturnDaily records.
 */
import type { FactorCode, FactorMarketStat } from "@/types/factors";
import { getFactorDef } from "../definitions/factor-codes";

const TRADING_DAYS = 252;

/** Horizon definitions in trading days. */
const HORIZONS: { key: string; tradingDays: number }[] = [
  { key: "1D", tradingDays: 1 },
  { key: "5D", tradingDays: 5 },
  { key: "1M", tradingDays: 21 },
  { key: "3M", tradingDays: 63 },
  { key: "6M", tradingDays: 126 },
  { key: "1Y", tradingDays: 252 },
];

/**
 * Compute market stats for each factor from a series map.
 *
 * @param factorSeries  Map from FactorCode → daily return array (newest last).
 * @param rfSeries      Daily RF rate array aligned to the same dates (newest last).
 * @param factorCodes   Factor codes to include (in display order).
 */
export function computeFactorMarketStats(
  factorSeries: Map<string, number[]>,
  rfSeries: number[],
  factorCodes: FactorCode[],
): FactorMarketStat[] {
  const n = rfSeries.length;
  const annualRf = rfSeries.length > 0
    ? rfSeries.reduce((s, r) => s + r, 0) / rfSeries.length * TRADING_DAYS
    : 0;

  return factorCodes.map((code) => {
    const series = factorSeries.get(code);
    if (!series || series.length === 0) {
      return nullStat(code);
    }

    // Per-horizon returns
    function horizonReturn(days: number): number | null {
      if (series!.length < days) return null;
      return series!.slice(-days).reduce((s, r) => s + r, 0);
    }

    const returns: Record<string, number | null> = {};
    for (const h of HORIZONS) {
      returns[h.key] = horizonReturn(h.tradingDays);
    }

    // Annualized volatility (from all available data or 252-day tail)
    const volWindow = series.slice(-TRADING_DAYS);
    const annualizedVol = sampleAnnualVol(volWindow);

    // Sharpe (annualized return / annualized vol, using all available data)
    const annualRet = series.reduce((s, r) => s + r, 0) / series.length * TRADING_DAYS;
    const sharpeRatio =
      annualizedVol > 0 ? (annualRet - annualRf) / annualizedVol : null;

    return {
      code,
      label: getFactorDef(code).label,
      return1D: returns["1D"] ?? null,
      return5D: returns["5D"] ?? null,
      return1M: returns["1M"] ?? null,
      return3M: returns["3M"] ?? null,
      return6M: returns["6M"] ?? null,
      return1Y: returns["1Y"] ?? null,
      annualizedVol: annualizedVol > 0 ? annualizedVol : null,
      sharpeRatio,
    };
  });
}

function sampleAnnualVol(series: number[]): number {
  const n = series.length;
  if (n < 2) return 0;
  const mean = series.reduce((s, r) => s + r, 0) / n;
  const variance = series.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

function nullStat(code: FactorCode): FactorMarketStat {
  return {
    code,
    label: getFactorDef(code).label,
    return1D: null,
    return5D: null,
    return1M: null,
    return3M: null,
    return6M: null,
    return1Y: null,
    annualizedVol: null,
    sharpeRatio: null,
  };
}
